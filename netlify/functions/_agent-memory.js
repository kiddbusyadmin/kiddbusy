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

async function createOwnerOrder({ ownerIdentity = 'harold', threadId = null, channel = 'dashboard', channelThreadKey = 'dashboard:primary', requestedAgentKey = 'president_agent', title, requestText, details = {} }) {
  const out = await sbFetch('agent_orders', {
    method: 'POST',
    body: {
      owner_identity: ownerIdentity,
      thread_id: threadId,
      channel,
      channel_thread_key: channelThreadKey,
      requested_agent_key: requestedAgentKey,
      title: String(title || requestText || 'Owner order').slice(0, 240),
      request_text: String(requestText || '').slice(0, 12000),
      status: 'pending_assignment',
      details: details && typeof details === 'object' ? details : {},
      updated_at: nowIso()
    },
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to create owner order');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function updateOwnerOrder({ orderId, status, summary = null, details = null, completed = false }) {
  const patch = {
    status: String(status || 'pending_assignment').slice(0, 80),
    updated_at: nowIso()
  };
  if (summary != null) patch.summary = String(summary).slice(0, 1200);
  if (details && typeof details === 'object') patch.details = details;
  if (completed) patch.completed_at = nowIso();
  const out = await sbFetch(`agent_orders?order_id=eq.${encodeURIComponent(String(orderId))}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to update owner order');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function getOwnerOrders({ ownerIdentity = 'harold', limit = 50, status = '' }) {
  const safe = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filters = [
    `owner_identity=eq.${encodeURIComponent(ownerIdentity)}`,
    'select=*',
    'order=updated_at.desc',
    `limit=${safe}`
  ];
  if (status) {
    if (status === 'open_funnel') filters.push('status=in.(pending_assignment,delegated,in_progress,blocked)');
    else filters.push(`status=eq.${encodeURIComponent(status)}`);
  }
  const out = await sbFetch(`agent_orders?${filters.join('&')}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function createProgressSubscription({ ownerIdentity = 'harold', agentKey = 'president_agent', channel = 'telegram', targetChatId = null, intervalMinutes = 5, scope = 'all_open_orders', summary = null, threadKey = null, metadata = {} }) {
  const mins = Math.min(Math.max(Number(intervalMinutes) || 5, 5), 1440);
  const ownerRaw = String(ownerIdentity || 'harold').trim().toLowerCase();
  const normalizedOwner = ['harold', 'owner', 'president', 'president_agent'].includes(ownerRaw) ? 'harold' : ownerRaw;
  const out = await sbFetch('agent_progress_subscriptions', {
    method: 'POST',
    body: {
      owner_identity: normalizedOwner,
      agent_key: agentKey,
      channel,
      target_chat_id: targetChatId,
      interval_minutes: mins,
      status: 'active',
      scope,
      summary: summary ? String(summary).slice(0, 600) : null,
      thread_key: threadKey || null,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      next_due_at: nowIso(),
      updated_at: nowIso()
    },
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to create progress subscription');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function updateProgressSubscription({ subscriptionId, status = null, summary = null, metadata = null, lastSentAt = null, nextDueAt = null }) {
  const patch = { updated_at: nowIso() };
  if (status != null) patch.status = String(status).slice(0, 80);
  if (summary != null) patch.summary = String(summary).slice(0, 600);
  if (metadata && typeof metadata === 'object') patch.metadata = metadata;
  if (lastSentAt != null) patch.last_sent_at = lastSentAt;
  if (nextDueAt != null) patch.next_due_at = nextDueAt;
  const out = await sbFetch(`agent_progress_subscriptions?subscription_id=eq.${encodeURIComponent(String(subscriptionId))}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to update progress subscription');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function getProgressSubscriptions({ ownerIdentity = 'harold', status = 'active', dueOnly = false, limit = 50 }) {
  const safe = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filters = ['select=*', 'order=updated_at.desc', `limit=${safe}`];
  if (String(ownerIdentity || '').trim()) filters.unshift(`owner_identity=eq.${encodeURIComponent(ownerIdentity)}`);
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
  if (dueOnly) filters.push(`next_due_at=lte.${encodeURIComponent(nowIso())}`);
  const out = await sbFetch(`agent_progress_subscriptions?${filters.join('&')}`);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function createProgressReport({ subscriptionId, ownerIdentity = 'harold', agentKey = 'president_agent', channel = 'telegram', targetChatId = null, reportText, reportMeta = {} }) {
  const out = await sbFetch('agent_progress_reports', {
    method: 'POST',
    body: {
      subscription_id: subscriptionId,
      owner_identity: ownerIdentity,
      agent_key: agentKey,
      channel,
      target_chat_id: targetChatId,
      report_text: String(reportText || '').slice(0, 12000),
      report_meta: reportMeta && typeof reportMeta === 'object' ? reportMeta : {}
    },
    prefer: 'return=representation'
  });
  if (!out.response.ok) throw new Error('Failed to create progress report');
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function getProgressReports({ ownerIdentity = 'harold', limit = 30 }) {
  const safe = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const out = await sbFetch(`agent_progress_reports?owner_identity=eq.${encodeURIComponent(ownerIdentity)}&select=*&order=created_at.desc&limit=${safe}`);
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
  getOpenTasks,
  createOwnerOrder,
  updateOwnerOrder,
  getOwnerOrders,
  createProgressSubscription,
  updateProgressSubscription,
  getProgressSubscriptions,
  createProgressReport,
  getProgressReports
};
