const { json, runRevenueConsensus } = require('./_revenue-consensus-core');

exports.handler = async (event) => {
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  const isCron = String(event.httpMethod || 'GET').toUpperCase() === 'GET';
  if (!isCron && source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }

  try {
    const out = await runRevenueConsensus();
    return json(200, out);
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
