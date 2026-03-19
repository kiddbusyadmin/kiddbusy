const { runAgentConversation } = require('./_agent-router-core');
const { getWorkflowById } = require('./_workflow-core');
const { runSingleWorkflow, classifyWorkflowExecution } = require('./_workflow-runner-core');
const AGENT_ROUTER_POLICY_VERSION = '2026-03-19-immediate-v4';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

function shouldRunNow(message) {
  const raw = String(message || '').trim().toLowerCase();
  if (!raw) return false;
  return /\b(publish|write|create|generate|draft|post|launch|build|fix|review|approve|queue|investigate|research)\b/.test(raw);
}

function extractWorkflowIds(reply) {
  const text = String(reply || '');
  const matches = text.match(/workflow\s+#(\d+)/gi) || [];
  const ids = [];
  for (const match of matches) {
    const num = Number(String(match).replace(/[^\d]/g, ''));
    if (Number.isFinite(num) && ids.indexOf(num) === -1) ids.push(num);
  }
  return ids;
}

function appendImmediateSummary(reply, rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return String(reply || '');
  const lines = [];
  for (const row of list) {
    const status = String(row.status || '').trim().toLowerCase();
    if (!status || ['queued', 'running', 'waiting'].includes(status)) continue;
    lines.push(`- ${String(row.assigned_agent_key || 'agent').replace(/_agent$/, '')} workflow #${row.workflow_id} ${status}${row.summary ? `: ${row.summary}` : ''}`);
  }
  if (!lines.length) return String(reply || '');
  return String(reply || '').trim() + '\n\nImmediate execution result:\n' + lines.join('\n');
}

function buildDeterministicExecutionReply(result, rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return String((result && result.reply) || '');
  const completed = list.filter((row) => String(row.status || '').trim().toLowerCase() === 'completed');
  const pending = list.filter((row) => {
    const status = String(row.status || '').trim().toLowerCase();
    return !status || status === 'queued' || status === 'running' || status === 'waiting';
  });
  const blocked = list.filter((row) => {
    const status = String(row.status || '').trim().toLowerCase();
    return status === 'blocked' || status === 'failed' || status === 'cancelled';
  });
  if (completed.length && pending.length === 0 && blocked.length === 0) {
    const primary = completed[0];
    return [
      `I ran this immediately through workflow #${primary.workflow_id}.`,
      primary.summary ? primary.summary : 'The workflow completed successfully.',
      '',
      'Tracked delegation:',
      `- ${String(primary.assigned_agent_key || 'agent').replace(/_agent$/, '')} workflow #${primary.workflow_id}`
    ].join('\n');
  }
  if (blocked.length && completed.length === 0 && pending.length === 0) {
    const primary = blocked[0];
    return [
      `I ran this immediately through workflow #${primary.workflow_id}, but it is blocked.`,
      primary.summary ? primary.summary : 'The workflow did not complete.',
      primary.blocked_reason ? `Blocked reason: ${primary.blocked_reason}` : '',
      '',
      'Tracked delegation:',
      `- ${String(primary.assigned_agent_key || 'agent').replace(/_agent$/, '')} workflow #${primary.workflow_id}`
    ].filter(Boolean).join('\n');
  }
  return appendImmediateSummary((result && result.reply) || '', list);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Requested-From',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      }
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!['kiddbusy-hq', 'kiddbusy-agent', 'telegram-webhook'].includes(source)) {
    return json(403, { error: 'Forbidden' });
  }
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }
  try {
    const result = await runAgentConversation({
      role: body.role || '',
      userMessage: body.message || '',
      history: body.history || [],
      channel: body.channel || 'dashboard',
      threadKey: body.thread_key || 'dashboard:primary',
      ownerIdentity: body.owner_identity || 'harold'
    });
    if (String(body.role || '') === 'president_agent' && shouldRunNow(body.message || '')) {
      const freshRows = Array.isArray(result && result.created_workflows) ? result.created_workflows : [];
      const workflowIds = freshRows.length
        ? freshRows.map((row) => row && row.workflow_id).filter(Boolean)
        : extractWorkflowIds(result && result.reply);
      const executed = [];
      for (const workflowId of workflowIds) {
        let workflow = freshRows.find((row) => Number(row && row.workflow_id) === Number(workflowId)) || null;
        if (!workflow) workflow = await getWorkflowById(workflowId);
        if (!workflow) continue;
        const status = String(workflow.status || '').trim().toLowerCase();
        if (!['queued', 'running', 'waiting'].includes(status)) {
          executed.push(workflow);
          continue;
        }
        const classification = classifyWorkflowExecution(workflow);
        if (classification.mode !== 'immediate') continue;
        executed.push(await runSingleWorkflow(workflow));
      }
      if (executed.length) {
        result.reply = buildDeterministicExecutionReply(result, executed);
        result.immediate_execution = true;
        result.created_workflows = executed;
      }
    }
    result.agent_router_policy_version = AGENT_ROUTER_POLICY_VERSION;
    return json(200, result);
  } catch (err) {
    return json(500, { error: err.message || 'Agent router failed' });
  }
};
