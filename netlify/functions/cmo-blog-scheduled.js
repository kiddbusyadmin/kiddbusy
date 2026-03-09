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
  var source = String(headers['x-requested-from'] || headers['X-Requested-From'] || '').toLowerCase();
  var isCron = method === 'GET';

  if (!isCron && source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }

  return json(200, {
    success: true,
    mode: 'diagnostic',
    method: method,
    has_headers: !!ev.headers
  });
};
