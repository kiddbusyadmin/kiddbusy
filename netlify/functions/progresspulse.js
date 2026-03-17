function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

function isoAfterMinutes(minutes) {
  var d = new Date();
  d.setMinutes(d.getMinutes() + Number(minutes || 5));
  return d.toISOString();
}

function humanAgentName(key) {
  var k = String(key || '').trim();
  if (k === 'president_agent') return 'President';
  if (k === 'operations_agent') return 'Operations';
  if (k === 'cmo_agent') return 'CMO';
  if (k === 'accountant_agent') return 'Accountant';
  if (k === 'research_agent') return 'Research';
  if (!k) return 'Unknown';
  return k.replace(/_/g, ' ');
}

async function sendTelegram(chatId, text) {
  var telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!telegramToken || !chatId) throw new Error('Telegram not configured');
  var res = await fetch('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text || '').slice(0, 4000)
    })
  });
  var body = await res.text();
  if (!res.ok) throw new Error('Telegram HTTP ' + res.status + ': ' + body);
  return body;
}

function buildProgressText(subscription, orders, tasks) {
  var held = orders.filter(function(o) { return String(o.status || '') === 'pending_assignment'; });
  var delegated = orders.filter(function(o) {
    var status = String(o.status || '');
    return status === 'delegated' || status === 'in_progress';
  });
  var completed = orders.filter(function(o) { return String(o.status || '') === 'completed'; });
  var lines = [];
  lines.push('President update (' + String(subscription.interval_minutes || 5) + ' min cadence)');
  lines.push('Open orders: ' + String(held.length + delegated.length) + ' | Held: ' + String(held.length) + ' | Delegated: ' + String(delegated.length) + ' | Completed tracked: ' + String(completed.length));
  if (held.length) {
    lines.push('Held: #' + String(held[0].order_id || '') + ' ' + String(held[0].summary || held[0].title || ''));
  } else {
    lines.push('Held: no orders waiting with President.');
  }
  if (delegated.length) {
    var d = delegated[0];
    var relatedTask = null;
    for (var i = 0; i < tasks.length; i += 1) {
      var orderId = ((tasks[i].details || {}).order_id || '');
      if (String(orderId) === String(d.order_id || '')) {
        relatedTask = tasks[i];
        break;
      }
    }
    if (relatedTask) {
      lines.push('Delegated: ' + humanAgentName(relatedTask.assigned_agent_key) + ' on "' + String(relatedTask.title || '') + '" [' + String(relatedTask.status || '') + ']');
    } else {
      lines.push('Delegated: #' + String(d.order_id || '') + ' ' + String(d.summary || d.title || ''));
    }
  } else {
    lines.push('Delegated: no open delegated work.');
  }
  var activeTasks = tasks.slice(0, 2).map(function(t) {
    return humanAgentName(t.assigned_agent_key) + ': ' + String(t.title || '') + ' [' + String(t.status || '') + ']';
  });
  if (activeTasks.length) lines.push('Team pulse: ' + activeTasks.join(' | '));
  else lines.push('Team pulse: no active specialist tasks.');
  lines.push('Reply to the President on Telegram to adjust cadence, pause updates, or ask for detail on any order.');
  return lines.join('\n');
}

exports.handler = async function handler() {
  try {
    var agentActivityModule = require('./_agent-activity');
    var memoryModule = require('./_agent-memory');
    var logAgentActivity = agentActivityModule.logAgentActivity;
    var getProgressSubscriptions = memoryModule.getProgressSubscriptions;
    var updateProgressSubscription = memoryModule.updateProgressSubscription;
    var createProgressReport = memoryModule.createProgressReport;
    var getOwnerOrders = memoryModule.getOwnerOrders;
    var getOpenTasks = memoryModule.getOpenTasks;
    var telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
    var subs = await getProgressSubscriptions({ ownerIdentity: '', status: 'active', dueOnly: true, limit: 50 });
    var sent = [];

    for (var s = 0; s < subs.length; s += 1) {
      var sub = subs[s];
      var chatId = sub.target_chat_id || telegramChatId;
      var ownerIdentity = sub.owner_identity || 'harold';
      var orders = await getOwnerOrders({ ownerIdentity: ownerIdentity, limit: 30, status: 'open_funnel' });
      var tasks = await getOpenTasks({ ownerIdentity: ownerIdentity, limit: 30 });
      var reportText = buildProgressText(sub, orders, tasks);
      await sendTelegram(chatId, reportText);
      await createProgressReport({
        subscriptionId: sub.subscription_id,
        ownerIdentity: ownerIdentity,
        agentKey: sub.agent_key || 'president_agent',
        channel: 'telegram',
        targetChatId: chatId,
        reportText: reportText,
        reportMeta: {
          open_orders: orders.length,
          held_orders: orders.filter(function(o) { return String(o.status || '') === 'pending_assignment'; }).length,
          delegated_orders: orders.filter(function(o) {
            var status = String(o.status || '');
            return status === 'delegated' || status === 'in_progress';
          }).length,
          open_tasks: tasks.length
        }
      });
      await updateProgressSubscription({
        subscriptionId: sub.subscription_id,
        lastSentAt: new Date().toISOString(),
        nextDueAt: isoAfterMinutes(sub.interval_minutes || 5),
        summary: 'Last sent with ' + String(orders.length) + ' open orders and ' + String(tasks.length) + ' open tasks.'
      });
      await logAgentActivity({
        agentKey: sub.agent_key || 'president_agent',
        status: 'success',
        summary: 'Progress update sent to Telegram for subscription ' + String(sub.subscription_id) + '.',
        details: {
          subscription_id: sub.subscription_id,
          channel: 'telegram',
          scope: sub.scope || 'all_open_orders'
        }
      });
      sent.push({ subscription_id: sub.subscription_id, chat_id: chatId });
    }

    return json(200, { success: true, due: subs.length, sent: sent });
  } catch (err) {
    try {
      var fallbackActivityModule = require('./_agent-activity');
      await fallbackActivityModule.logAgentActivity({
        agentKey: 'president_agent',
        status: 'error',
        summary: 'Progress pulse failed: ' + String((err && err.message) || 'unknown error').slice(0, 800),
        details: { run_type: 'progresspulse' }
      });
    } catch (_) {}
    return json(500, {
      error: (err && err.message) ? err.message : 'Progress pulse failed',
      type: (err && err.name) ? err.name : 'Error'
    });
  }
};
