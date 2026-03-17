exports.handler = async function handler() {
  var activity = require('./_agent-activity');
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: true, probe: 'require_agent_activity', has_log: !!(activity && activity.logAgentActivity) })
  };
};
