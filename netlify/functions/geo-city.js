// Detect approximate user city/state from IP using Netlify request headers.
exports.handler = async function handler(event) {
  if ((event.httpMethod || 'GET') !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  var headers = event.headers || {};
  var rawIp = String(
    headers['x-nf-client-connection-ip'] ||
    headers['client-ip'] ||
    headers['x-forwarded-for'] ||
    ''
  ).split(',')[0].trim();

  if (!rawIp || rawIp === '127.0.0.1' || rawIp === '::1') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, reason: 'no_public_ip' })
    };
  }

  try {
    var ctl = new AbortController();
    var timeout = setTimeout(function () { ctl.abort(); }, 2500);

    var resp = await fetch('https://ipapi.co/' + encodeURIComponent(rawIp) + '/json/', {
      method: 'GET',
      signal: ctl.signal,
      headers: { 'User-Agent': 'kiddbusy-geo/1.0' }
    });

    clearTimeout(timeout);

    var data = await resp.json();
    if (!resp.ok || !data || data.error) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, reason: 'lookup_failed' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        city: data.city || null,
        state: data.region || null,
        state_code: data.region_code || null,
        country_code: data.country_code || null
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, reason: 'lookup_error' })
    };
  }
};
