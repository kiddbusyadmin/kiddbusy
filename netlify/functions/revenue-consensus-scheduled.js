const { json, runRevenueConsensus } = require('./_revenue-consensus-core');

exports.handler = async () => {
  try {
    const out = await runRevenueConsensus();
    return json(200, out);
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
