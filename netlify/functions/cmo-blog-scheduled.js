const { runCmoBlog } = require('./_cmo-blog-core');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function isoAfterMinutes(minutes) {
  var d = new Date();
  d.setMinutes(d.getMinutes() + Number(minutes || 5));
  return d.toISOString();
}

async function sbRequest(path, options) {
  var reqOptions = options || {};
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: reqOptions.method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: reqOptions.prefer || 'return=representation'
    },
    body: reqOptions.body ? JSON.stringify(reqOptions.body) : undefined
  });
  var text = await res.text();
  var data = [];
  try {
    data = text ? JSON.parse(text) : [];
  } catch (_) {
    data = text;
  }
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text);
  return data;
}

async function logPresidentActivity(summary, status, details) {
  return sbRequest('agent_activity', {
    method: 'POST',
    body: {
      agent_key: 'president_agent',
      summary: String(summary || '').slice(0, 1200),
      status: String(status || 'info').slice(0, 40),
      details: details || null
    }
  });
}

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) throw new Error('Telegram not configured');
  var res = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text || '').slice(0, 4000) })
  });
  var body = await res.text();
  if (!res.ok) throw new Error('Telegram HTTP ' + res.status + ': ' + body);
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
  if (held.length) lines.push('Held: #' + String(held[0].order_id || '') + ' ' + String(held[0].summary || held[0].title || ''));
  else lines.push('Held: no orders waiting with President.');
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
    if (relatedTask) lines.push('Delegated: ' + humanAgentName(relatedTask.assigned_agent_key) + ' on "' + String(relatedTask.title || '') + '" [' + String(relatedTask.status || '') + ']');
    else lines.push('Delegated: #' + String(d.order_id || '') + ' ' + String(d.summary || d.title || ''));
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

async function runProgressPulse() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Supabase config missing');
  var ts = encodeURIComponent(nowIso());
  var subs = await sbRequest('agent_progress_subscriptions?select=*&status=eq.active&next_due_at=lte.' + ts + '&order=updated_at.desc&limit=50', {
    method: 'GET',
    prefer: 'return=representation'
  });
  var sent = [];
  for (var s = 0; s < subs.length; s += 1) {
    var sub = subs[s];
    var chatId = sub.target_chat_id || TELEGRAM_CHAT_ID;
    var ownerIdentity = sub.owner_identity || 'harold';
    var orders = await sbRequest('agent_orders?owner_identity=eq.' + encodeURIComponent(ownerIdentity) + '&status=in.(pending_assignment,delegated,in_progress)&select=*&order=updated_at.desc&limit=30', {
      method: 'GET',
      prefer: 'return=representation'
    });
    var tasks = await sbRequest('agent_tasks?owner_identity=eq.' + encodeURIComponent(ownerIdentity) + '&status=in.(open,in_progress)&select=*&order=updated_at.desc&limit=30', {
      method: 'GET',
      prefer: 'return=representation'
    });
    var reportText = buildProgressText(sub, orders, tasks);
    await sendTelegram(chatId, reportText);
    await sbRequest('agent_progress_reports', {
      method: 'POST',
      body: {
        subscription_id: sub.subscription_id,
        owner_identity: ownerIdentity,
        agent_key: sub.agent_key || 'president_agent',
        channel: 'telegram',
        target_chat_id: chatId,
        report_text: reportText,
        report_meta: {
          open_orders: orders.length,
          held_orders: orders.filter(function(o) { return String(o.status || '') === 'pending_assignment'; }).length,
          delegated_orders: orders.filter(function(o) {
            var status = String(o.status || '');
            return status === 'delegated' || status === 'in_progress';
          }).length,
          open_tasks: tasks.length
        }
      }
    });
    await sbRequest('agent_progress_subscriptions?subscription_id=eq.' + encodeURIComponent(String(sub.subscription_id)), {
      method: 'PATCH',
      body: {
        last_sent_at: nowIso(),
        next_due_at: isoAfterMinutes(sub.interval_minutes || 5),
        summary: 'Last sent with ' + String(orders.length) + ' open orders and ' + String(tasks.length) + ' open tasks.',
        updated_at: nowIso()
      }
    });
    await logPresidentActivity('Progress update sent to Telegram for subscription ' + String(sub.subscription_id) + '.', 'success', {
      subscription_id: sub.subscription_id,
      channel: 'telegram',
      scope: sub.scope || 'all_open_orders'
    });
    sent.push({ subscription_id: sub.subscription_id, chat_id: chatId });
  }
  return { success: true, due: subs.length, sent: sent };
}

exports.handler = async function handler(event) {
  var ev = event || {};
  var rawUrl = String(ev.rawUrl || 'https://kiddbusy.local/.netlify/functions/cmo-blog-scheduled');
  var url = new URL(rawUrl);
  var progressOnly = url.searchParams.get('progress_only') === '1';
  var progress = { success: true, due: 0, sent: [] };

  try {
    progress = await runProgressPulse();
  } catch (err) {
    progress = { success: false, error: String((err && err.message) || err || 'Progress pulse failed') };
    try {
      await logPresidentActivity('Progress pulse failed: ' + String((err && err.message) || err || 'unknown error').slice(0, 800), 'error', { run_type: 'cmo_blog_scheduled_progress' });
    } catch (_) {}
  }

  if (progressOnly) {
    return json(progress.success ? 200 : 500, progress);
  }

  var isCron = String(ev.httpMethod || 'GET').toUpperCase() === 'GET';
  if (isCron) {
    var minute = new Date().getUTCMinutes();
    if (minute % 20 !== 0) {
      return json(progress.success ? 200 : 500, {
        success: !!progress.success,
        progress: progress,
        blog: { skipped: true, reason: 'blog_runs_every_20_minutes' }
      });
    }
  }

  var blogResponse = await runCmoBlog(event);
  try {
    var parsed = JSON.parse(String(blogResponse.body || '{}'));
    parsed.progress = progress;
    blogResponse.body = JSON.stringify(parsed);
  } catch (_) {}
  return blogResponse;
};
