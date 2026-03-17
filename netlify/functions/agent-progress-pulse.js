exports.handler = async function handler() {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://kiddbusy.com';
  const response = await fetch(base.replace(/\/$/, '') + '/.netlify/functions/db-proxy?action=run_progress_pulse', {
    method: 'GET',
    headers: { 'User-Agent': 'KiddBusyProgressPulse/1.0' }
  });
  const text = await response.text();
  return {
    statusCode: response.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: text
  };
};
