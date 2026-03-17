const { runCmoBlog } = require('./_cmo-blog-core');

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

async function runProgressPulseViaDbProxy() {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://kiddbusy.com';
  const response = await fetch(base.replace(/\/$/, '') + '/.netlify/functions/db-proxy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-From': 'kiddbusy-hq'
    },
    body: JSON.stringify({ action: 'run_progress_pulse' })
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(data.error || ('Progress pulse HTTP ' + response.status));
  return data;
}

exports.handler = async function handler(event) {
  const ev = event || {};
  const rawUrl = String(ev.rawUrl || 'https://kiddbusy.local/.netlify/functions/cmo-blog-scheduled');
  const url = new URL(rawUrl);
  const progressOnly = url.searchParams.get('progress_only') === '1';
  let progress = { success: true, due: 0, sent: [] };

  try {
    progress = await runProgressPulseViaDbProxy();
  } catch (err) {
    progress = { success: false, error: String((err && err.message) || err || 'Progress pulse failed') };
  }

  if (progressOnly) {
    return json(progress.success ? 200 : 500, progress);
  }

  const isCron = String(ev.httpMethod || 'GET').toUpperCase() === 'GET';
  if (isCron) {
    const minute = new Date().getUTCMinutes();
    if (minute % 20 !== 0) {
      return json(progress.success ? 200 : 500, {
        success: !!progress.success,
        progress: progress,
        blog: { skipped: true, reason: 'blog_runs_every_20_minutes' }
      });
    }
  }

  const blogResponse = await runCmoBlog(event);
  try {
    const parsed = JSON.parse(String(blogResponse.body || '{}'));
    parsed.progress = progress;
    blogResponse.body = JSON.stringify(parsed);
  } catch (_) {}
  return blogResponse;
};
