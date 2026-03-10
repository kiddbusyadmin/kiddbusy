const { runCmoBlog } = require('./_cmo-blog-core');
const { runPlanner } = require('./cmo-social');

exports.handler = async function handler(event) {
  const blogResult = await runCmoBlog(event);
  // Keep social planning in the same cadence so CMO queue stays current.
  try {
    await runPlanner();
  } catch (_) {}
  return blogResult;
};
