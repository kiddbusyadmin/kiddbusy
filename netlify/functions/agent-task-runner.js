const { runAgentTasks } = require('./_agent-task-runner-core');

exports.handler = async function handler() {
  try {
    const result = await runAgentTasks();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message || 'Agent task runner failed' })
    };
  }
};
