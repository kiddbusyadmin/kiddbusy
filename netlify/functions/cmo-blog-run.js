const NETLIFY_MAIN_DOMAIN = 'https://main--clinquant-biscuit-44a0dc.netlify.app';

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

exports.handler = async function handler(event) {
  var ev = event || {};
  var headers = ev.headers || {};
  var method = String(ev.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });

  var source = String(headers['x-requested-from'] || headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') return json(403, { error: 'Forbidden' });

  var body = '{}';
  if (typeof ev.body === 'string' && ev.body.trim()) body = ev.body;

  try {
    var upstream = await fetch(NETLIFY_MAIN_DOMAIN + '/.netlify/functions/cmo-blog-run-background', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-From': 'kiddbusy-hq'
      },
      body: body
    });

    // Background functions return 202 when queued.
    if (upstream.status === 202) {
      return json(202, { success: true, queued: true, message: 'CMO blog run queued' });
    }

    var text = await upstream.text();
    return json(upstream.status || 502, {
      success: false,
      queued: false,
      error: 'Upstream background invocation failed',
      details: text || null
    });
  } catch (err) {
    return json(502, {
      success: false,
      queued: false,
      error: 'Failed to reach background runner',
      details: String((err && err.message) || err)
    });
  }
};
