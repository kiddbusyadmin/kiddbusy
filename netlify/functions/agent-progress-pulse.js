const { logAgentActivity } = require('./_agent-activity');
const {
  getProgressSubscriptions,
  updateProgressSubscription,
  createProgressReport,
  getOwnerOrders,
  getOpenTasks
} = require('./_agent-memory');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

function isoAfterMinutes(minutes) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function humanAgentName(key) {
  const k = String(key || '').trim();
  if (k === 'president_agent') return 'President';
  if (k === 'operations_agent') return 'Operations';
  if (k === 'cmo_agent') return 'CMO';
  if (k === 'accountant_agent') return 'Accountant';
  if (k === 'research_agent') return 'Research';
  if (!k) return 'Unknown';
  return k.replace(/_/g, ' ');
}

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) throw new Error('Telegram not configured');
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text || '').slice(0, 4000)
    })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${body}`);
  return body;
}

function buildProgressText(subscription, orders, tasks) {
  const held = orders.filter((o) => String(o.status || '') === 'pending_assignment');
  const delegated = orders.filter((o) => ['delegated', 'in_progress'].includes(String(o.status || '')));
  const completed = orders.filter((o) => String(o.status || '') === 'completed');
  const lines = [];
  lines.push(`President update (${subscription.interval_minutes} min cadence)`);
  lines.push(`Open orders: ${held.length + delegated.length} | Held: ${held.length} | Delegated: ${delegated.length} | Completed tracked: ${completed.length}`);
  if (held.length) {
    const h = held[0];
    lines.push(`Held: #${h.order_id} ${h.summary || h.title}`);
  } else {
    lines.push('Held: no orders waiting with President.');
  }
  if (delegated.length) {
    const d = delegated[0];
    const relatedTask = tasks.find((t) => String(((t.details || {}).order_id || '')) === String(d.order_id || ''));
    if (relatedTask) lines.push(`Delegated: ${humanAgentName(relatedTask.assigned_agent_key)} on "${relatedTask.title}" [${relatedTask.status}]`);
    else lines.push(`Delegated: #${d.order_id} ${d.summary || d.title}`);
  } else {
    lines.push('Delegated: no open delegated work.');
  }
  const activeTasks = tasks.slice(0, 2).map((t) => `${humanAgentName(t.assigned_agent_key)}: ${t.title} [${t.status}]`);
  if (activeTasks.length) {
    lines.push(`Team pulse: ${activeTasks.join(' | ')}`);
  } else {
    lines.push('Team pulse: no active specialist tasks.');
  }
  lines.push('Reply to the President on Telegram to adjust cadence, pause updates, or ask for detail on any order.');
  return lines.join('\n');
}

exports.handler = async () => {
  try {
    const subs = await getProgressSubscriptions({ ownerIdentity: 'harold', status: 'active', dueOnly: true, limit: 50 });
    const sent = [];
    for (const sub of subs) {
      const chatId = sub.target_chat_id || TELEGRAM_CHAT_ID;
      const orders = await getOwnerOrders({ ownerIdentity: sub.owner_identity || 'harold', limit: 30, status: 'open_funnel' });
      const tasks = await getOpenTasks({ ownerIdentity: sub.owner_identity || 'harold', limit: 30 });
      const reportText = buildProgressText(sub, orders, tasks);
      await sendTelegram(chatId, reportText);
      await createProgressReport({
        subscriptionId: sub.subscription_id,
        ownerIdentity: sub.owner_identity || 'harold',
        agentKey: sub.agent_key || 'president_agent',
        channel: 'telegram',
        targetChatId: chatId,
        reportText,
        reportMeta: {
          open_orders: orders.length,
          held_orders: orders.filter((o) => String(o.status || '') === 'pending_assignment').length,
          delegated_orders: orders.filter((o) => ['delegated', 'in_progress'].includes(String(o.status || ''))).length,
          open_tasks: tasks.length
        }
      });
      await updateProgressSubscription({
        subscriptionId: sub.subscription_id,
        lastSentAt: new Date().toISOString(),
        nextDueAt: isoAfterMinutes(sub.interval_minutes || 5),
        summary: `Last sent with ${orders.length} open orders and ${tasks.length} open tasks.`
      });
      await logAgentActivity({
        agentKey: sub.agent_key || 'president_agent',
        status: 'success',
        summary: `Progress update sent to Telegram for subscription ${sub.subscription_id}.`,
        details: {
          subscription_id: sub.subscription_id,
          channel: 'telegram',
          scope: sub.scope || 'all_open_orders'
        }
      });
      sent.push({ subscription_id: sub.subscription_id, chat_id: chatId });
    }
    return json(200, { success: true, due: subs.length, sent });
  } catch (err) {
    await logAgentActivity({
      agentKey: 'president_agent',
      status: 'error',
      summary: `Progress pulse failed: ${String(err.message || 'unknown error').slice(0, 800)}`,
      details: { run_type: 'agent_progress_pulse' }
    });
    return json(500, { error: err.message || 'Progress pulse failed' });
  }
};
