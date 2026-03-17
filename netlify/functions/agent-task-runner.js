exports.handler = async function handler() {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://kiddbusy.com').replace(/\/$/, '');
  const response = await fetch(base + '/.netlify/functions/db-proxy?action=run_agent_tasks', {
    method: 'GET',
    headers: { 'User-Agent': 'KiddBusyAgentTaskRunner/1.0' }
  });
  const text = await response.text();
  return {
    statusCode: response.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: text
  };
};
