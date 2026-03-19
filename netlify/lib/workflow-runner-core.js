const { runCmoBlog } = require('../functions/_cmo-blog-core');
const { upsertResearchArtifact } = require('../functions/_research-memory');
const { logAgentActivity } = require('../functions/_agent-activity');
const { getTrafficSummary, getActivitySummary } = require('../functions/_analytics-core');
const {
  getWorkflows,
  updateWorkflow,
  appendWorkflowEvent,
  projectWorkflowAsTask,
  nowIso,
  normalizeOwnerIdentity
} = require('../functions/_workflow-core');
const { sbFetch } = require('../functions/_accounting-core');

function cleanCity(value) {
  return String(value || '')
    .split(',')[0]
    .replace(/\b(Public|Parks?|Playgrounds?|Activities|Listicle|Guide|Blog|Post|Weekend|Family|Families|Toddler|Toddlers)\b.*$/i, '')
    .trim();
}

function extractCity(text) {
  const raw = String(text || '');
  const match = raw.match(/\b(?:for|in|on|about)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s*[A-Z]{2})?\b/);
  return match && match[1] ? cleanCity(match[1]) : '';
}

function inferTargetCount(payload) {
  const explicit = Number(payload.target_count || payload.article_count || 0);
  if (explicit > 0) return Math.min(Math.max(Math.round(explicit), 1), 25);
  return 1;
}

function inferTouchedRecordCount(payload) {
  const direct = Number(payload.record_count || payload.records_count || payload.affected_count || 0);
  if (direct > 0) return Math.max(Math.round(direct), 0);
  const candidateArrays = [
    payload.ids,
    payload.record_ids,
    payload.listing_ids,
    payload.post_ids,
    payload.submission_ids,
    payload.city_ids
  ];
  for (const candidate of candidateArrays) {
    if (Array.isArray(candidate)) return candidate.length;
  }
  return 1;
}

function classifyWorkflowExecution(workflow) {
  const row = workflow || {};
  const wfKey = String(row.workflow_key || '').trim();
  const payload = Object.assign({}, row.input || {}, row.details || {});
  const targetCount = inferTargetCount(payload);
  const recordCount = inferTouchedRecordCount(payload);
  const expectsLongRun = Number(payload.expected_runtime_seconds || 0) > 20;
  const expectedModelCalls = Number(payload.expected_model_calls || 0);
  const externalWait = !!(
    payload.wait_for_webhook ||
    payload.wait_for_email_click ||
    payload.wait_for_owner_response ||
    payload.wait_for_user_response ||
    payload.wait_for_schedule ||
    payload.wait_for_payment_confirmation
  );
  const explicitBackground = !!(
    payload.background === true ||
    payload.defer === true ||
    payload.async === true ||
    payload.batch === true ||
    payload.backfill === true ||
    payload.reconcile === true ||
    payload.scheduled === true
  );

  if (!wfKey) {
    return { mode: 'background', reason: 'No workflow key was provided, so immediate execution is unsafe.' };
  }
  if (externalWait) {
    return { mode: 'external_wait', reason: 'This workflow is waiting on an external event or human response.' };
  }
  if (explicitBackground) {
    return { mode: 'background', reason: 'This workflow was explicitly marked as batch, scheduled, deferred, backfill, or reconcile work.' };
  }
  if (expectsLongRun || expectedModelCalls > 2 || recordCount > 25) {
    return { mode: 'background', reason: 'This workflow exceeds the immediate execution budget.' };
  }

  if (wfKey === 'answer_analytics_question') {
    return { mode: 'immediate', reason: 'Analytics questions are always immediate.' };
  }
  if (wfKey === 'publish_blog_post') {
    return { mode: 'immediate', reason: 'A single blog post should execute immediately.' };
  }
  if (wfKey === 'publish_city_blog_batch') {
    if (targetCount <= 1) {
      return { mode: 'immediate', reason: 'A single-city, single-article publish request should execute immediately.' };
    }
    return { mode: 'background', reason: 'Multi-article blog batches are background work.' };
  }
  if (wfKey === 'research_request') {
    if (targetCount <= 1 && recordCount <= 25 && !payload.multi_city && !payload.batch) {
      return { mode: 'immediate', reason: 'A single-topic research request should execute immediately.' };
    }
    return { mode: 'background', reason: 'Multi-scope or broad research work belongs in background mode.' };
  }
  if (wfKey === 'ops_investigation') {
    if (!payload.audit_scope && !payload.multi_city && recordCount <= 25) {
      return { mode: 'immediate', reason: 'A single investigation should execute immediately.' };
    }
    return { mode: 'background', reason: 'Wide audits and reconciliations are background work.' };
  }
  if (wfKey === 'fix_content_quality_issue') {
    if (targetCount <= 1 && recordCount <= 25) {
      return { mode: 'immediate', reason: 'Single-item content fixes should execute immediately.' };
    }
    return { mode: 'background', reason: 'Bulk content cleanup belongs in background mode.' };
  }
  if (wfKey === 'review_submission') {
    if (recordCount <= 1) {
      return { mode: 'immediate', reason: 'Single submission review should execute immediately.' };
    }
    return { mode: 'background', reason: 'Moderation sweeps are background work.' };
  }
  if (wfKey === 'process_owner_claim') {
    return { mode: 'immediate', reason: 'Owner claims should execute immediately unless waiting on outside proof.' };
  }
  if (wfKey === 'process_sponsorship') {
    return { mode: 'immediate', reason: 'Sponsorship processing should execute immediately until it reaches an external wait state.' };
  }
  if (wfKey === 'blog_title_qc') {
    if (recordCount <= 25) {
      return { mode: 'immediate', reason: 'Small title-quality fixes should execute immediately.' };
    }
    return { mode: 'background', reason: 'Large title cleanup batches are background work.' };
  }

  return { mode: 'background', reason: 'Unclassified workflows default to background mode until explicitly approved for immediate execution.' };
}

function tokenizeTopic(text) {
  const stop = new Set([
    'a', 'an', 'and', 'are', 'article', 'articles', 'as', 'at', 'be', 'blog', 'blogs', 'by',
    'complete', 'completed', 'create', 'do', 'done', 'end', 'endtoend', 'ensure', 'for', 'from',
    'generate', 'guide', 'guides', 'how', 'i', 'immediately', 'in', 'is', 'it', 'its', 'list',
    'listicle', 'listicles', 'live', 'me', 'nc', 'need', 'on', 'or', 'post', 'posts', 'publish',
    'published', 'publishing', 'research', 'that', 'the', 'this', 'through', 'to', 'up', 'verify',
    'want', 'with', 'write'
  ]);
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && !stop.has(part));
}

function inferKeywordTarget(payload, workflow, order, city) {
  const explicit = String(payload.keyword_target || '').trim();
  if (explicit) return explicit;
  const combined = [
    String(workflow.title || ''),
    String((order && order.request_text) || '')
  ].join(' ').toLowerCase();
  if (!combined.trim()) return '';
  const cityPart = String(city || '').trim();
  if (/\bpublic parks?\b/.test(combined)) return cityPart ? `${cityPart} public parks` : 'public parks';
  if (/\bindoor playgrounds?\b/.test(combined)) return cityPart ? `indoor playgrounds ${cityPart}` : 'indoor playgrounds';
  if (/\bplaygrounds?\b/.test(combined)) return cityPart ? `${cityPart} playgrounds` : 'playgrounds';
  if (/\brainy day\b/.test(combined)) return cityPart ? `rainy day activities ${cityPart}` : 'rainy day activities';
  if (/\bwater\b|\bswimming\b/.test(combined)) return cityPart ? `water and swimming activities ${cityPart}` : 'water and swimming activities';
  if (/\bteen\b|\bteens\b/.test(combined)) return cityPart ? `teen activities ${cityPart}` : 'teen activities';
  if (/\btoddler\b|\btoddlers\b/.test(combined)) return cityPart ? `toddler activities ${cityPart}` : 'toddler activities';
  return '';
}

function buildTopicSignals(keywordTarget, workflow, order, city) {
  const text = [
    String(keywordTarget || ''),
    String(workflow.title || ''),
    String((order && order.request_text) || '')
  ].join(' ');
  const rawTokens = tokenizeTopic(text);
  const cityTokens = tokenizeTopic(city).filter(Boolean);
  const filtered = rawTokens.filter((token) => cityTokens.indexOf(token) === -1);
  const unique = [];
  for (const token of filtered) {
    if (unique.indexOf(token) === -1) unique.push(token);
  }
  return unique.slice(0, 6);
}

function doesPostMatchTopic(post, topicSignals) {
  if (!Array.isArray(topicSignals) || !topicSignals.length) return true;
  const haystack = [
    String((post && post.title) || ''),
    String((post && post.slug) || '')
  ].join(' ').toLowerCase();
  let matched = 0;
  for (const token of topicSignals) {
    if (haystack.indexOf(String(token || '').toLowerCase()) >= 0) matched += 1;
  }
  if (topicSignals.length === 1) return matched >= 1;
  return matched >= Math.min(2, topicSignals.length);
}

function requestImpliesPublication(text) {
  return /\b(publish|published|article|blog post|listicle|post)\b/i.test(String(text || ''));
}

async function loadOrder(orderId) {
  if (!orderId) return null;
  const out = await sbFetch(`agent_orders?order_id=eq.${encodeURIComponent(String(orderId))}&select=*&limit=1`);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function patchOrder(orderId, patch) {
  if (!orderId) return null;
  const out = await sbFetch(`agent_orders?order_id=eq.${encodeURIComponent(String(orderId))}`, {
    method: 'PATCH',
    body: Object.assign({}, patch || {}, { updated_at: nowIso() }),
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to patch order');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function listCityPosts(city) {
  if (!city) return [];
  const safe = encodeURIComponent(city);
  const out = await sbFetch(
    `blog_posts?select=id,slug,title,status,city,published_at,created_at&source=eq.cmo_agent&city=ilike.*${safe}*&status=in.(draft,published)&limit=200`
  );
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function runBlogPublishWorkflow(workflow, order) {
  const payload = Object.assign({}, workflow.input || {}, workflow.details || {});
  const city = cleanCity(payload.city || extractCity(workflow.title || (order && order.request_text) || ''));
  const targetCount = inferTargetCount(payload);
  const keywordTarget = inferKeywordTarget(payload, workflow, order, city);
  const topicSignals = buildTopicSignals(keywordTarget, workflow, order, city);
  const before = await listCityPosts(city);
  const beforePublishedRows = before.filter((row) => String(row.status || '') === 'published');
  const beforeMatchingRows = beforePublishedRows.filter((row) => doesPostMatchTopic(row, topicSignals));
  const beforePublished = beforeMatchingRows.length;
  const remaining = Math.max(targetCount - beforePublished, 0);
  if (remaining <= 0) {
    return {
      status: 'completed',
      summary: 'Blog publish target already satisfied' + (city ? (' for ' + city) : '') + (keywordTarget ? (' (' + keywordTarget + ')') : '') + '.',
      output: { published_count: beforePublished, remaining_count: 0 },
      evidence: {
        post_ids: beforeMatchingRows.map((row) => row.id).slice(0, targetCount),
        keyword_target: keywordTarget || null,
        topic_signals: topicSignals
      }
    };
  }
  const batchSize = Math.min(remaining, 3);
  const result = await runCmoBlog({
    httpMethod: 'POST',
    headers: { 'x-requested-from': 'kiddbusy-hq' },
    body: JSON.stringify({
      target_city: city,
      queue_target: batchSize,
      max_generate_per_run: batchSize,
      publish_rate: batchSize,
      force_publish_generated: true,
      distribution_enabled: true,
      keyword_target: keywordTarget || undefined
    })
  });
  const parsed = JSON.parse((result && result.body) || '{}');
  if (!result || Number(result.statusCode || 500) >= 400) {
    throw new Error(parsed.error || 'Blog workflow failed');
  }
  const after = await listCityPosts(city);
  const afterPublishedRows = after.filter((row) => String(row.status || '') === 'published');
  const afterMatchingRows = afterPublishedRows.filter((row) => doesPostMatchTopic(row, topicSignals));
  const afterPublished = afterMatchingRows.length;
  const remainingAfter = Math.max(targetCount - afterPublished, 0);
  return {
    status: remainingAfter > 0 ? 'waiting' : 'completed',
    summary: 'CMO workflow' + (city ? (' for ' + city) : '') + (keywordTarget ? (' (' + keywordTarget + ')') : '') + ': published ' + String(afterPublished) + '/' + String(targetCount) + '.',
    output: {
      city,
      keyword_target: keywordTarget || null,
      generated_count: Number(parsed.generated_count || 0),
      published_count: afterPublished,
      remaining_count: remainingAfter
    },
    evidence: {
      post_ids: afterMatchingRows.map((row) => row.id).slice(0, targetCount),
      keyword_target: keywordTarget || null,
      topic_signals: topicSignals
    }
  };
}

// Structured memo workflow: replaces freeform runDelegatedMemoWorkflow.
// Agents are prompted to return a JSON-structured evidence block.
// If no evidence is extractable, the workflow is blocked rather than silently "completed".
async function runStructuredMemoWorkflow(workflow, order) {
  const workflowKey = String(workflow.workflow_key || 'ops_investigation');
  const { runAgentConversation } = require('./agent-router-core');
  const reply = await runAgentConversation({
    role: workflow.assigned_agent_key,
    userMessage:
      'Complete this typed workflow from President.\n' +
      'Workflow type: ' + workflowKey +
      '\nTitle: ' + String(workflow.title || '') +
      '\nSummary: ' + String(workflow.summary || '') +
      '\nInput: ' + JSON.stringify(workflow.input || {}) +
      '\nOwner request: ' + String((order && order.request_text) || '') +
      '\n\nRequired: End your response with a JSON evidence block in this exact format:\n' +
      '```json\n{"actions_taken":["..."],"findings":"...","outcome":"completed|partial|blocked","blocked_reason":""}\n```',
    history: [],
    channel: 'dashboard',
    threadKey: 'workflow:' + String(workflow.workflow_id),
    ownerIdentity: workflow.owner_identity || 'harold'
  });
  const replyText = String((reply && reply.reply) || '');

  // Attempt to extract the JSON evidence block from the reply.
  let evidence = null;
  let outcome = 'blocked';
  let blockedReason = 'Agent response did not include a valid structured evidence block.';
  const jsonMatch = replyText.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const parsedOutcome = String(parsed.outcome || '').toLowerCase();
      const actionsTaken = Array.isArray(parsed.actions_taken)
        ? parsed.actions_taken.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const findings = String(parsed.findings || '').trim();
      const validOutcome = ['completed', 'partial', 'blocked'].includes(parsedOutcome);
      if (validOutcome && actionsTaken.length && findings) {
        evidence = Object.assign({}, parsed, {
          actions_taken: actionsTaken,
          findings,
          provider: (reply && reply.provider) || ''
        });
        outcome = parsedOutcome === 'partial' ? 'waiting' : parsedOutcome;
        blockedReason = parsedOutcome === 'blocked'
          ? String(parsed.blocked_reason || 'Agent reported blocked.').slice(0, 1200)
          : null;
      } else {
        blockedReason = 'Structured evidence block was present but incomplete or invalid.';
      }
      if (parsedOutcome === 'blocked' && evidence) {
        outcome = 'blocked';
        blockedReason = String(parsed.blocked_reason || 'Agent reported blocked.').slice(0, 1200);
      }
    } catch (_) {}
  }

  return {
    status: outcome,
    summary: replyText.replace(/```json[\s\S]*?```/g, '').trim().slice(0, 1200) || (outcome === 'blocked' ? 'Workflow blocked.' : 'Workflow completed.'),
    output: { reply: replyText, provider: (reply && reply.provider) || '' },
    evidence: evidence || { provider: (reply && reply.provider) || '', validation_error: blockedReason },
    blocked_reason: blockedReason
  };
}

// Analytics workflow: answers deterministic questions from the analytics core directly.
// Avoids LLM for known data queries, writes structured evidence.
async function runAnalyticsWorkflow(workflow, order) {
  const payload = Object.assign({}, workflow.input || {});
  const question = String(payload.question || workflow.title || (order && order.request_text) || '').trim();
  let trafficData = null;
  let activityData = null;
  try {
    trafficData = await getTrafficSummary({ range: payload.range || '7d' });
  } catch (_) {}
  try {
    activityData = await getActivitySummary({ range: payload.range || '7d' });
  } catch (_) {}
  if (!trafficData && !activityData) {
    return {
      status: 'blocked',
      summary: 'Analytics data unavailable — Supabase query failed.',
      output: {},
      evidence: {},
      blocked_reason: 'Could not fetch traffic or activity data from database.'
    };
  }
  const summary = [
    trafficData ? `Sessions (${payload.range || '7d'}): ${trafficData.total_sessions || '--'} | Manual searches: ${trafficData.manual_searches || '--'} | Auto geo: ${trafficData.auto_geo_searches || '--'}` : null,
    activityData ? `Events (${payload.range || '7d'}): ${activityData.total_events || '--'} | Top city: ${activityData.top_city || '--'}` : null
  ].filter(Boolean).join('\n');
  return {
    status: 'completed',
    summary: summary || 'Analytics data retrieved.',
    output: { question, traffic: trafficData || {}, activity: activityData || {} },
    evidence: { traffic: trafficData || {}, activity: activityData || {}, question }
  };
}

async function runResearchWorkflow(workflow, order) {
  const result = await runStructuredMemoWorkflow(workflow, order);
  const publishRequested = requestImpliesPublication(workflow.title || '') ||
    requestImpliesPublication((order && order.request_text) || '');
  const evidence = result && result.evidence && typeof result.evidence === 'object' ? result.evidence : {};
  const hasPublicationEvidence = !!(
    evidence.post_id ||
    evidence.post_ids ||
    evidence.published_url ||
    evidence.slug
  );
  if (publishRequested && !hasPublicationEvidence) {
    return {
      status: 'blocked',
      summary: 'Research completed, but no blog post evidence was produced. Publish requests must run through a publish workflow and prove the resulting article exists.',
      output: Object.assign({}, result.output || {}, { research_only: true }),
      evidence: Object.assign({}, evidence, { validation_error: 'missing_publication_evidence' }),
      blocked_reason: 'This request asked for publication, but the research workflow returned no published post evidence.'
    };
  }
  try {
    await upsertResearchArtifact({
      ownerIdentity: normalizeOwnerIdentity(workflow.owner_identity || 'harold'),
      orderId: workflow.order_id || null,
      agentKey: 'research_agent',
      question: workflow.title || (order && order.request_text) || 'Research workflow',
      summary: result.summary,
      fullNotes: ((result.output || {}).reply) || '',
      status: result.status,
      city: cleanCity((workflow.input || {}).city || ''),
      tags: ['workflow_research'],
      metadata: {
        workflow_id: workflow.workflow_id,
        workflow_key: workflow.workflow_key
      }
    });
  } catch (err) {
    await appendWorkflowEvent({
      workflowId: workflow.workflow_id,
      eventType: 'warning',
      status: 'warning',
      summary: 'Research artifact persistence failed, but workflow result is preserved.',
      details: { error: String((err && err.message) || err || 'artifact failure').slice(0, 500) }
    });
  }
  return result;
}

async function runSingleWorkflow(workflow) {
  const order = await loadOrder(workflow.order_id);
  await updateWorkflow({
    workflowId: workflow.workflow_id,
    patch: { status: 'running', last_progress_at: nowIso() },
    appendEvent: {
      eventType: 'started',
      status: 'info',
      summary: 'Workflow execution started.'
    }
  });

  let result;
  const wfKey = String(workflow.workflow_key || '');
  if (wfKey === 'publish_city_blog_batch' || wfKey === 'publish_blog_post') {
    result = await runBlogPublishWorkflow(workflow, order);
  } else if (wfKey === 'research_request') {
    result = await runResearchWorkflow(workflow, order);
  } else if (wfKey === 'answer_analytics_question') {
    result = await runAnalyticsWorkflow(workflow, order);
  } else {
    // Handles: ops_investigation, review_submission, process_owner_claim,
    // process_sponsorship, fix_content_quality_issue, and any future typed keys.
    result = await runStructuredMemoWorkflow(workflow, order);
  }

  const nextStatus = String(result.status || 'completed');
  const row = await updateWorkflow({
    workflowId: workflow.workflow_id,
    patch: {
      status: nextStatus,
      summary: result.summary,
      output: result.output || {},
      evidence: result.evidence || {},
      last_progress_at: nowIso(),
      next_run_at: nextStatus === 'waiting' ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : nowIso(),
      blocked_reason: nextStatus === 'blocked' ? (result.blocked_reason || null) : null
    },
    appendEvent: {
      eventType: nextStatus === 'completed' ? 'completed' : 'progress',
      status: nextStatus === 'completed' ? 'success' : (nextStatus === 'blocked' ? 'warning' : 'info'),
      summary: result.summary,
      details: result.output || {}
    }
  });

  if (workflow.order_id) {
    await patchOrder(workflow.order_id, {
      status: nextStatus === 'completed' ? 'completed' : (nextStatus === 'blocked' ? 'blocked' : 'in_progress'),
      summary: String(result.summary || '').slice(0, 1200),
      details: Object.assign({}, (order && order.details) || {}, {
        workflow_id: workflow.workflow_id,
        workflow_key: workflow.workflow_key,
        assigned_agent_key: workflow.assigned_agent_key,
        workflow_status: nextStatus
      }),
      completed_at: nextStatus === 'completed' ? nowIso() : null
    });
  }

  await logAgentActivity({
    agentKey: workflow.assigned_agent_key || 'unknown',
    status: nextStatus === 'completed' ? 'success' : (nextStatus === 'blocked' ? 'warning' : 'info'),
    summary: String(result.summary || '').slice(0, 1200),
    details: {
      workflow_id: workflow.workflow_id,
      workflow_key: workflow.workflow_key,
      order_id: workflow.order_id || null
    }
  });

  return row;
}

function shouldRunWorkflowImmediately(workflow) {
  return classifyWorkflowExecution(workflow).mode === 'immediate';
}

async function runWorkflowEngine(limit = 12) {
  const workflows = await getWorkflows({ ownerIdentity: '', status: 'ready', limit });
  const processed = [];
  for (const workflow of workflows) {
    try {
      const row = await runSingleWorkflow(workflow);
      processed.push(projectWorkflowAsTask(row));
    } catch (err) {
      await updateWorkflow({
        workflowId: workflow.workflow_id,
        patch: {
          status: 'blocked',
          blocked_reason: String((err && err.message) || err || 'workflow error').slice(0, 1200),
          last_progress_at: nowIso()
        },
        appendEvent: {
          eventType: 'error',
          status: 'error',
          summary: 'Workflow failed: ' + String((err && err.message) || err || 'unknown error').slice(0, 1000)
        }
      });
      processed.push({
        workflow_id: workflow.workflow_id,
        status: 'blocked',
        assigned_agent_key: workflow.assigned_agent_key,
        title: workflow.title,
        summary: String((err && err.message) || err || 'workflow error').slice(0, 240)
      });
    }
  }
  return { success: true, processed_count: processed.length, processed };
}

module.exports = {
  runWorkflowEngine,
  runSingleWorkflow,
  shouldRunWorkflowImmediately,
  classifyWorkflowExecution
};
