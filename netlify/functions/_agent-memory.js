const { sbFetch } = require('./_accounting-core');

function nowIso() {
  return new Date().toISOString();
}

async function getOrCreateThread({ channel, channelThreadKey, ownerIdentity = 'harold', activeAgentKey = 'president_agent' }) {
  const query = `agent_threads?channel=eq.${encodeURIComponent(channel)}&channel_thread_key=eq.${encodeURIComponent(channelThreadKey)}&select=*&limit=1`;
  const existing = await sbFetch(query);
  if (existing.response.ok && Array.isArray(existing.data) && existing.data.length) {
    return existing.data[0];
  }
  const created = await sbFetch('agent_threads?on_conflict=channel,channel_thread_key', {
    method: 'POST',
    body: {
      channel,
      channel_thread_key: channelThreadKey,
      owner_identity: ownerIdentity,
      active_agent_key: activeAgentKey,
      title: null,
      status: 'active',
      last_message_at: nowIso(),
      updated_at: nowIso()
    },
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!created.response.ok) throw new Error('Failed to create agent thread');
  return Array.isArray(created.data) && created.data.length ? created.data[0] : null;
}

async function appendMessage({ threadId, agentKey = null, role, content, metadata = null }) {
  const created = await sbFetch('agent_messages', {
    method: 'POST',
    body: {
      thread_id: threadId,
      agent_key: agentKey,
      role,
      content: String(content || '').slice(0, 20000),
      metadata: metadata && typeof metadata === 'object' ? metadata : null
    },
    prefer: 'return=representation'
  });
  if (!created.response.ok) throw new Error('Failed to append agent message');
  await sbFetch(`agent_threads?thread_id=eq.${encodeURIComponent(String(threadId))}`, {
    method: 'PATCH',
    body: {
      last_message_at: nowIso(),
      updated_at: nowIso()
    },
    prefer: 'return=minimal'
  });
  return Array.isArray(created.data) && created.data.length ? created.data[0] : null;
}

async function getRecentMessages(threadId, limit = 20) {
  const safe = Math.min(Math.max(Number(limit) || 20, 1), 80);
  const out = await sbFetch(`agent_messages?thread_id=eq.${encodeURIComponent(String(threadId))}&select=role,content,agent_key,created_at,metadata&order=created_at.desc&limit=${safe}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data.slice().reverse();
}

async function upsertMemory({ ownerIdentity = 'harold', agentKey = 'president_agent', memoryKind, key, value, pinned = false }) {
  const out = await sbFetch('agent_memory?on_conflict=owner_identity,agent_key,memory_kind,key', {
    method: 'POST',
    body: {
      owner_identity: ownerIdentity,
      agent_key: agentKey,
      memory_kind: memoryKind,
      key,
      value: value && typeof value === 'object' ? value : { value },
      pinned: !!pinned,
      updated_at: nowIso()
    },
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to upsert agent memory');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function getAgentMemories({ ownerIdentity = 'harold', agentKey = 'president_agent', limit = 50 }) {
  const safe = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const out = await sbFetch(`agent_memory?owner_identity=eq.${encodeURIComponent(ownerIdentity)}&agent_key=eq.${encodeURIComponent(agentKey)}&select=memory_kind,key,value,pinned,updated_at&order=pinned.desc,updated_at.desc&limit=${safe}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function createTask({ ownerIdentity = 'harold', requestedByAgentKey = 'president_agent', assignedAgentKey, title, summary = '', details = {}, priority = 'normal' }) {
  const out = await sbFetch('agent_tasks', {
    method: 'POST',
    body: {
      owner_identity: ownerIdentity,
      requested_by_agent_key: requestedByAgentKey,
      assigned_agent_key: assignedAgentKey,
      title: String(title || '').slice(0, 240),
      status: 'open',
      priority: String(priority || 'normal').slice(0, 40),
      summary: summary ? String(summary).slice(0, 1200) : null,
      details: details && typeof details === 'object' ? details : {}
    },
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to create agent task');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function getOpenTasks({ ownerIdentity = 'harold', limit = 30 }) {
  const safe = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const out = await sbFetch(`agent_tasks?owner_identity=eq.${encodeURIComponent(ownerIdentity)}&status=in.(open,in_progress)&select=*&order=updated_at.desc&limit=${safe}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

module.exports = {
  getOrCreateThread,
  appendMessage,
  getRecentMessages,
  upsertMemory,
  getAgentMemories,
  createTask,
  getOpenTasks
};
