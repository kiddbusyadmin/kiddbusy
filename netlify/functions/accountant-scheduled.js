const { buildFinanceSnapshot, upsertFinanceSnapshot } = require('./_accounting-core');
const { logAgentActivity } = require('./_agent-activity');

exports.handler = async () => {
  try {
    const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
    await logAgentActivity({
      agentKey: 'accountant_agent',
      status: 'success',
      summary: `Scheduled finance snapshot saved. MRR $${snapshot.mrr_active}, projected 30d net $${snapshot.net_projection_30d}.`,
      details: snapshot
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, snapshot })
    };
  } catch (err) {
    await logAgentActivity({
      agentKey: 'accountant_agent',
      status: 'error',
      summary: `Scheduled finance snapshot failed: ${err.message || 'unknown error'}`,
      details: { error: err.message || 'unknown_error' }
    });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Unexpected error' })
    };
  }
};
