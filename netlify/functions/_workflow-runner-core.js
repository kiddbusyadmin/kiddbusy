const { runCmoBlog } = require('./_cmo-blog-core');
const { runAgentConversation } = require('./_agent-router-core');
const { upsertResearchArtifact } = require('./_research-memory');
const { logAgentActivity } = require('./_agent-activity');
const { getTrafficSummary, getActivitySummary } = require('./_analytics-core');
const {
  getWorkflows,
  updateWorkflow,
  appendWorkflowEvent,
  projectWorkflowAsTask,
  nowIso,
  normalizeOwnerIdentity
} = require('./_workflow-core');
const { sbFetch } = require('./_accounting-core');

function cleanCity(value) {
  return String(value || '').split(',')[0].trim();
}

function extractCity(text) {
  const raw = String(text || '');
  const match = raw.match(/\b(?:for|in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s*[A-Z]{2})?\b/);
  return match && match[1] ? cleanCity(match[1]) : '';
}

function inferTargetCount(payload) {
  const explicit = Number(payload.target_count || payload.article_count || 0);
  if (explicit > 0) return Math.min(Math.max(Math.round(explicit), 1), 25);
  return 1;
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
  const keywordTarget = String(payload.keyword_target || '').trim();
  const before = await listCityPosts(city);
  const beforePublished = before.filter((row) => String(row.status || '') === 'published').length;
  const remaining = Math.max(targetCount - beforePublished, 0);
  if (remaining <= 0) {
    return {
      status: 'completed',
      summary: 'Blog publish target already satisfied' + (city ? (' for ' + city) : '') + '.',
      output: { published_count: beforePublished, remaining_count: 0 },
      evidence: { post_ids: before.map((row) => row.id).slice(0, targetCount) }
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
  const afterPublished = after.filter((row) => String(row.status || '') === 'published').length;
  const remainingAfter = Math.max(targetCount - afterPublished, 0);
  return {
    status: remainingAfter > 0 ? 'waiting' : 'completed',
    summary: 'CMO workflow' + (city ? (' for ' + city) : '') + ': published ' + String(afterPublished) + '/' + String(targetCount) + '.',
    output: {
      city,
      keyword_target: keywordTarget || null,
      generated_count: Number(parsed.generated_count || 0),
      published_count: afterPublished,
      remaining_count: remainingAfter
    },
    evidence: {
      post_ids: after.filter((row) => String(row.status || '') === 'published').map((row) => row.id).slice(0, targetCount)
    }
  };
}

// Structured memo workflow: replaces freeform runDelegatedMemoWorkflow.
// Agents are prompted to return a JSON-structured evidence block.
// If no evidence is extractable, the workflow is blocked rather than silently "completed".
async function runStructuredMemoWorkflow(workflow, order) {
  const workflowKey = String(workflow.workflow_key || 'ops_investigation');
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
  runWorkflowEngine
};
