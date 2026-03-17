const { runCmoBlog } = require('./_cmo-blog-core');
const { runAgentConversation } = require('./_agent-router-core');
const { upsertResearchArtifact } = require('./_research-memory');
const { logAgentActivity } = require('./_agent-activity');
const {
  getWorkflows,
  updateWorkflow,
  appendWorkflowEvent,
  projectWorkflowAsTask,
  nowIso
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
      distribution_enabled: true
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
      generated_count: Number(parsed.generated_count || 0),
      published_count: afterPublished,
      remaining_count: remainingAfter
    },
    evidence: {
      post_ids: after.filter((row) => String(row.status || '') === 'published').map((row) => row.id).slice(0, targetCount)
    }
  };
}

async function runDelegatedMemoWorkflow(workflow, order) {
  const reply = await runAgentConversation({
    role: workflow.assigned_agent_key,
    userMessage:
      'Complete this typed workflow from President.\n' +
      'Workflow: ' + String(workflow.workflow_key || '') +
      '\nTitle: ' + String(workflow.title || '') +
      '\nSummary: ' + String(workflow.summary || '') +
      '\nOwner request: ' + String((order && order.request_text) || '') +
      '\nReturn a concrete completion memo with findings, actions taken, and evidence.',
    history: [],
    channel: 'dashboard',
    threadKey: 'workflow:' + String(workflow.workflow_id),
    ownerIdentity: workflow.owner_identity || 'harold'
  });
  return {
    status: 'completed',
    summary: String((reply && reply.reply) || '').slice(0, 1200) || 'Workflow completed.',
    output: { reply: (reply && reply.reply) || '', provider: (reply && reply.provider) || '' },
    evidence: { provider: (reply && reply.provider) || '' }
  };
}

async function runResearchWorkflow(workflow, order) {
  const result = await runDelegatedMemoWorkflow(workflow, order);
  await upsertResearchArtifact({
    ownerIdentity: workflow.owner_identity || 'harold',
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
  if (workflow.workflow_key === 'publish_city_blog_batch') {
    result = await runBlogPublishWorkflow(workflow, order);
  } else if (workflow.workflow_key === 'research_request') {
    result = await runResearchWorkflow(workflow, order);
  } else {
    result = await runDelegatedMemoWorkflow(workflow, order);
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
  const workflows = await getWorkflows({ ownerIdentity: '', status: 'open_or_in_progress', limit });
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
