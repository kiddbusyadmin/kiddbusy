const { getAgentRegistry } = require('../lib/agent-router-core');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') return json(403, { error: 'Forbidden' });
  try {
    const registry = await getAgentRegistry();
    return json(200, { success: true, registry });
  } catch (err) {
    return json(500, { error: err.message || 'Failed to load agent registry' });
  }
};
