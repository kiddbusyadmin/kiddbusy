const { runAgentConversation } = require('./_agent-router-core');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Requested-From',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      }
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!['kiddbusy-hq', 'kiddbusy-agent', 'telegram-webhook'].includes(source)) {
    return json(403, { error: 'Forbidden' });
  }
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }
  try {
    const result = await runAgentConversation({
      role: body.role || '',
      userMessage: body.message || '',
      history: body.history || [],
      channel: body.channel || 'dashboard'
    });
    return json(200, result);
  } catch (err) {
    return json(500, { error: err.message || 'Agent router failed' });
  }
};
