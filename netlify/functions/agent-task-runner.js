function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

async function runDbProxyAction(action) {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://kiddbusy.com';
  const response = await fetch(base.replace(/\/$/, '') + '/.netlify/functions/db-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-From': 'kiddbusy-hq'
    },
    body: JSON.stringify({ action: action })
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error || (String(action || 'db_action') + ' HTTP ' + response.status));
  }
  return data;
}

exports.handler = async function handler() {
  let progress = { success: true, due: 0, sent: [] };
  let tasks = { success: true, processed_count: 0, processed: [] };
  let watchdog = { success: true, stalled_count: 0, escalated_count: 0, inspected: [] };

  try {
    progress = await runDbProxyAction('run_progress_pulse');
  } catch (err) {
    progress = { success: false, error: String((err && err.message) || err || 'Progress pulse failed') };
  }

  try {
    const taskPayload = await runDbProxyAction('run_agent_tasks');
    tasks = taskPayload.tasks || taskPayload;
    watchdog = taskPayload.watchdog || watchdog;
  } catch (err) {
    tasks = { success: false, error: String((err && err.message) || err || 'Agent task runner failed') };
  }

  const ok = [progress.success, tasks.success, watchdog.success].every(Boolean);
  return json(ok ? 200 : 500, {
    success: ok,
    progress: progress,
    tasks: tasks,
    watchdog: watchdog
  });
};
