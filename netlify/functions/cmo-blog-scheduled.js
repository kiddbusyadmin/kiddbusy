const { runCmoBlog } = require('./_cmo-blog-core');

exports.handler = async function handler(event) {
  return runCmoBlog(event);
};
