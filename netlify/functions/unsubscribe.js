const { setUnsubscribed, verifyUnsubscribeToken, normalizeEmail } = require('./_email-compliance');

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#f7f8fc;color:#1f2747;padding:24px}.card{max-width:560px;margin:30px auto;background:#fff;border:1px solid #e7e9f2;border-radius:12px;padding:24px}h1{font-size:1.2rem;margin:0 0 8px}p{line-height:1.6;color:#45507a}.muted{color:#6e78a1;font-size:.9rem}</style></head><body><div class="card">${body}</div></body></html>`;
}

async function handleUnsubscribe(email, reason) {
  const e = normalizeEmail(email);
  if (!e || !e.includes('@')) {
    return { ok: false, error: 'Invalid email' };
  }
  try {
    await setUnsubscribed(e, reason || 'recipient_unsubscribe', 'unsubscribe_link');
    return { ok: true, email: e };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to update preferences' };
  }
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    const token = qs.token ? String(qs.token) : '';
    const emailParam = qs.email ? String(qs.email) : '';

    let result;
    if (token) {
      const verify = verifyUnsubscribeToken(token);
      if (!verify.ok) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: htmlPage('Invalid Link', `<h1>Invalid unsubscribe link</h1><p>${verify.error}</p><p class="muted">Request a fresh email and try again.</p>`)
        };
      }
      result = await handleUnsubscribe(verify.email, 'unsubscribe_link_click');
    } else if (emailParam) {
      result = await handleUnsubscribe(emailParam, 'unsubscribe_manual');
    } else {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: htmlPage('Missing Token', '<h1>Missing unsubscribe token</h1><p>Use the link from your email.</p>')
      };
    }

    if (!result.ok) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: htmlPage('Error', `<h1>We could not process unsubscribe</h1><p>${result.error}</p>`) 
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlPage('Unsubscribed', `<h1>You're unsubscribed</h1><p><strong>${result.email}</strong> will no longer receive KiddBusy marketing emails.</p><p class="muted">If this was a mistake, contact support to re-subscribe.</p>`)
    };
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}

    let email = '';
    if (body.token) {
      const verify = verifyUnsubscribeToken(String(body.token));
      if (!verify.ok) {
        return { statusCode: 400, body: JSON.stringify({ error: verify.error }) };
      }
      email = verify.email;
    } else {
      email = normalizeEmail(body.email);
    }

    const result = await handleUnsubscribe(email, body.reason || 'unsubscribe_api');
    if (!result.ok) return { statusCode: 500, body: JSON.stringify({ error: result.error }) };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, email: result.email }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
