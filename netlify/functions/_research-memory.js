const { sbFetch } = require('./_accounting-core');

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, maxLen) {
  const text = String(value || '').trim();
  if (!text) return null;
  return maxLen ? text.slice(0, maxLen) : text;
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return values
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 25);
}

function normalizeSourceRefs(sourceRefs) {
  if (!Array.isArray(sourceRefs)) return [];
  return sourceRefs
    .map((row) => {
      if (typeof row === 'string') return { label: row.slice(0, 200) };
      if (!row || typeof row !== 'object') return null;
      return {
        label: normalizeText(row.label || row.title || row.url || '', 200),
        url: normalizeText(row.url || '', 500),
        note: normalizeText(row.note || row.summary || '', 400)
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function cleanCity(value) {
  return normalizeText(String(value || '').split(',')[0], 120);
}

function inferCity(task = {}, order = null) {
  const details = task.details || {};
  if (details.city) return cleanCity(details.city);
  const text = [task.title, task.summary, order && order.request_text].filter(Boolean).join(' ');
  const direct = String(text).match(/\b(?:for|in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s*[A-Z]{2})?\b/);
  return direct && direct[1] ? cleanCity(direct[1]) : null;
}

function inferQuestion(task = {}, order = null) {
  return normalizeText(
    task.title || (task.details && task.details.research_question) || (order && order.request_text) || '',
    1000
  ) || 'Research task';
}

async function upsertResearchArtifact(input = {}) {
  const payload = {
    owner_identity: normalizeText(input.ownerIdentity || 'harold', 120) || 'harold',
    task_id: input.taskId || null,
    order_id: input.orderId || null,
    agent_key: normalizeText(input.agentKey || 'research_agent', 120) || 'research_agent',
    question: normalizeText(input.question || '', 1000) || 'Research task',
    summary: normalizeText(input.summary || '', 2000),
    full_notes: normalizeText(input.fullNotes || '', 20000),
    status: normalizeText(input.status || 'open', 80) || 'open',
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
    city: cleanCity(input.city || ''),
    tags: normalizeTags(input.tags),
    source_refs: normalizeSourceRefs(input.sourceRefs),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    updated_at: nowIso()
  };
  if (payload.status === 'completed') payload.completed_at = nowIso();
  const conflictKey = payload.task_id ? 'task_id' : 'owner_identity,agent_key,question';
  const out = await sbFetch(`research_artifacts?on_conflict=${encodeURIComponent(conflictKey)}`, {
    method: 'POST',
    body: payload,
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to upsert research artifact');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function seedResearchArtifactFromTask(task, order = null) {
  if (!task || String(task.assigned_agent_key || '') !== 'research_agent') return null;
  const details = task.details || {};
  return upsertResearchArtifact({
    ownerIdentity: task.owner_identity || 'harold',
    taskId: task.task_id,
    orderId: details.order_id || (order && order.order_id) || null,
    agentKey: 'research_agent',
    question: inferQuestion(task, order),
    summary: normalizeText(task.summary || 'Research assignment created.', 1200),
    status: String(task.status || 'open').toLowerCase() === 'completed' ? 'completed' : 'open',
    city: inferCity(task, order),
    tags: []
      .concat(details.tags || [])
      .concat(details.research_request ? ['research'] : [])
      .concat(inferCity(task, order) ? ['city:' + String(inferCity(task, order)).toLowerCase().replace(/\s+/g, '_')] : []),
    metadata: {
      source: 'agent_task_creation',
      task_title: normalizeText(task.title || '', 240),
      task_summary: normalizeText(task.summary || '', 1200),
      task_details: details
    }
  });
}

async function getResearchArtifacts({ ownerIdentity = 'harold', agentKey = '', status = '', city = '', limit = 25 } = {}) {
  const safe = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const filters = [
    'select=*',
    'order=updated_at.desc',
    `limit=${safe}`,
    `owner_identity=eq.${encodeURIComponent(ownerIdentity)}`
  ];
  if (agentKey) filters.push(`agent_key=eq.${encodeURIComponent(agentKey)}`);
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
  if (city) filters.push(`city=ilike.*${encodeURIComponent(String(city).trim())}*`);
  const out = await sbFetch(`research_artifacts?${filters.join('&')}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

module.exports = {
  upsertResearchArtifact,
  seedResearchArtifactFromTask,
  getResearchArtifacts,
  inferQuestion,
  inferCity
};
