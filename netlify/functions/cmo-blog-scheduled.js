const { runCmoBlog } = require('./_cmo-blog-core');

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
  if (!response.ok) throw new Error(data.error || (String(action || 'db_action') + ' HTTP ' + response.status));
  return data;
}

exports.handler = async function handler(event) {
  const ev = event || {};
  const rawUrl = String(ev.rawUrl || 'https://kiddbusy.local/.netlify/functions/cmo-blog-scheduled');
  const url = new URL(rawUrl);
  const progressOnly = url.searchParams.get('progress_only') === '1';
  const taskOnly = url.searchParams.get('tasks_only') === '1';
  const watchdogOnly = url.searchParams.get('watchdog_only') === '1';
  let progress = { success: true, due: 0, sent: [] };
  let taskRun = { success: true, processed_count: 0, processed: [] };
  let watchdog = { success: true, stalled_count: 0, escalated_count: 0, inspected: [] };

  try {
    progress = await runDbProxyAction('run_progress_pulse');
  } catch (err) {
    progress = { success: false, error: String((err && err.message) || err || 'Progress pulse failed') };
  }

  try {
    const taskPayload = await runDbProxyAction('run_agent_tasks');
    taskRun = taskPayload.tasks || taskPayload;
    watchdog = taskPayload.watchdog || watchdog;
  } catch (err) {
    taskRun = { success: false, error: String((err && err.message) || err || 'Agent task runner failed') };
  }

  if (progressOnly || taskOnly || watchdogOnly) {
    const payload = {
      progress: progress,
      tasks: taskRun,
      watchdog: watchdog
    };
    const ok = [progress.success, taskRun.success, watchdog.success].every(Boolean);
    return json(ok ? 200 : 500, payload);
  }

  const isCron = String(ev.httpMethod || 'GET').toUpperCase() === 'GET';
  if (isCron) {
    const minute = new Date().getUTCMinutes();
    if (minute % 20 !== 0) {
      const ok = [progress.success, taskRun.success, watchdog.success].every(Boolean);
      return json(ok ? 200 : 500, {
        success: ok,
        progress: progress,
        tasks: taskRun,
        watchdog: watchdog,
        blog: { skipped: true, reason: 'blog_runs_every_20_minutes' }
      });
    }
  }

  const blogResponse = await runCmoBlog(event);
  try {
    const parsed = JSON.parse(String(blogResponse.body || '{}'));
    parsed.progress = progress;
    parsed.tasks = taskRun;
    parsed.watchdog = watchdog;
    blogResponse.body = JSON.stringify(parsed);
  } catch (_) {}
  return blogResponse;
};
