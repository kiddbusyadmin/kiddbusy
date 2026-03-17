const { sbFetch } = require('./_accounting-core');

function nowIso() {
  return new Date().toISOString();
}

function normalizeOwnerIdentity(value) {
  const raw = String(value || 'harold').trim().toLowerCase();
  if (['harold', 'owner', 'president', 'president_agent'].includes(raw)) return 'harold';
  return raw || 'harold';
}

function normalizeStatus(status) {
  const raw = String(status || '').trim().toLowerCase();
  if (['queued', 'running', 'waiting', 'completed', 'blocked', 'failed'].includes(raw)) return raw;
  return 'queued';
}

function normalizePriority(priority) {
  const raw = String(priority || '').trim().toLowerCase();
  if (['critical', 'high', 'normal', 'low'].includes(raw)) return raw;
  return 'normal';
}

async function appendWorkflowEvent({ workflowId, eventType = 'note', stepKey = null, status = 'info', summary, details = {} }) {
  const out = await sbFetch('workflow_events', {
    method: 'POST',
    body: {
      workflow_id: workflowId,
      event_type: String(eventType || 'note').slice(0, 120),
      step_key: stepKey ? String(stepKey).slice(0, 120) : null,
      status: String(status || 'info').slice(0, 40),
      summary: String(summary || '').slice(0, 1200),
      details: details && typeof details === 'object' ? details : {}
    },
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to append workflow event');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function createWorkflow(input = {}) {
  const out = await sbFetch('workflow_runs', {
    method: 'POST',
    body: {
      owner_identity: normalizeOwnerIdentity(input.ownerIdentity || 'harold'),
      order_id: input.orderId || null,
      thread_id: input.threadId || null,
      workflow_key: String(input.workflowKey || 'ops_investigation').slice(0, 120),
      requested_by_agent_key: String(input.requestedByAgentKey || 'president_agent').slice(0, 120),
      assigned_agent_key: String(input.assignedAgentKey || 'operations_agent').slice(0, 120),
      title: String(input.title || 'Workflow').slice(0, 240),
      status: normalizeStatus(input.status || 'queued'),
      priority: normalizePriority(input.priority || 'normal'),
      summary: input.summary ? String(input.summary).slice(0, 1200) : null,
      input: input.payload && typeof input.payload === 'object' ? input.payload : {},
      output: input.output && typeof input.output === 'object' ? input.output : {},
      evidence: input.evidence && typeof input.evidence === 'object' ? input.evidence : {},
      details: input.details && typeof input.details === 'object' ? input.details : {},
      blocked_reason: input.blockedReason ? String(input.blockedReason).slice(0, 1200) : null,
      retry_count: Number(input.retryCount || 0) || 0,
      last_progress_at: input.lastProgressAt || null,
      next_run_at: input.nextRunAt || nowIso(),
      updated_at: nowIso(),
      completed_at: normalizeStatus(input.status) === 'completed' ? nowIso() : null
    },
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to create workflow');
  const row = Array.isArray(out.data) && out.data.length ? out.data[0] : null;
  if (row && row.workflow_id) {
    await appendWorkflowEvent({
      workflowId: row.workflow_id,
      eventType: 'created',
      status: 'info',
      summary: 'Workflow created: ' + String(row.title || 'Untitled workflow'),
      details: {
        workflow_key: row.workflow_key,
        assigned_agent_key: row.assigned_agent_key,
        order_id: row.order_id || null
      }
    });
  }
  return row;
}

async function updateWorkflow({ workflowId, patch = {}, appendEvent = null }) {
  const body = Object.assign({}, patch || {}, { updated_at: nowIso() });
  if (body.status) body.status = normalizeStatus(body.status);
  if (body.priority) body.priority = normalizePriority(body.priority);
  if (body.summary != null) body.summary = String(body.summary).slice(0, 1200);
  if (body.blocked_reason != null) body.blocked_reason = body.blocked_reason ? String(body.blocked_reason).slice(0, 1200) : null;
  if (body.status === 'completed' && !body.completed_at) body.completed_at = nowIso();
  const out = await sbFetch(`workflow_runs?workflow_id=eq.${encodeURIComponent(String(workflowId))}`, {
    method: 'PATCH',
    body,
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to update workflow');
  const row = Array.isArray(out.data) && out.data.length ? out.data[0] : null;
  if (row && appendEvent && appendEvent.summary) {
    await appendWorkflowEvent(Object.assign({ workflowId: row.workflow_id }, appendEvent));
  }
  return row;
}

async function getWorkflowById(workflowId) {
  const out = await sbFetch(`workflow_runs?workflow_id=eq.${encodeURIComponent(String(workflowId))}&select=*&limit=1`);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function getWorkflowEvents(workflowId, limit = 20) {
  const safe = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const out = await sbFetch(`workflow_events?workflow_id=eq.${encodeURIComponent(String(workflowId))}&select=*&order=created_at.desc&limit=${safe}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function getWorkflows({ ownerIdentity = 'harold', status = '', limit = 50, includeLegacy = false } = {}) {
  const safe = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filters = [
    'select=*',
    'order=updated_at.desc',
    `limit=${safe}`
  ];
  if (ownerIdentity) filters.push(`owner_identity=eq.${encodeURIComponent(ownerIdentity)}`);
  if (status) {
    if (status === 'active') filters.push('status=in.(queued,running,waiting,blocked)');
    else if (status === 'open_or_in_progress') filters.push('status=in.(queued,running,waiting)');
    else filters.push(`status=eq.${encodeURIComponent(status)}`);
  }
  const out = await sbFetch(`workflow_runs?${filters.join('&')}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

function projectWorkflowAsTask(row) {
  if (!row) return null;
  const statusMap = {
    queued: 'open',
    running: 'in_progress',
    waiting: 'in_progress',
    blocked: 'blocked',
    completed: 'completed',
    failed: 'blocked'
  };
  return {
    task_id: 'wf:' + String(row.workflow_id),
    workflow_id: row.workflow_id,
    workflow_key: row.workflow_key,
    owner_identity: row.owner_identity,
    requested_by_agent_key: row.requested_by_agent_key,
    assigned_agent_key: row.assigned_agent_key,
    title: row.title,
    status: statusMap[String(row.status || 'queued')] || 'open',
    priority: row.priority || 'normal',
    summary: row.summary || null,
    details: Object.assign({}, row.details || {}, {
      workflow_id: row.workflow_id,
      workflow_key: row.workflow_key,
      order_id: row.order_id || null,
      blocked_reason: row.blocked_reason || null
    }),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at
  };
}

module.exports = {
  createWorkflow,
  updateWorkflow,
  getWorkflowById,
  getWorkflowEvents,
  getWorkflows,
  appendWorkflowEvent,
  projectWorkflowAsTask,
  nowIso,
  normalizeOwnerIdentity
};
