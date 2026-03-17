const dbProxy = require('./db-proxy');

exports.handler = async function handler() {
  return dbProxy.handler({
    httpMethod: 'GET',
    queryStringParameters: { action: 'run_agent_tasks' },
    headers: {},
    body: ''
  });
};
