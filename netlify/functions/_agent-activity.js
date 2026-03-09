const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function logAgentActivity({
  agentKey,
  summary,
  status = 'info',
  details = null
}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, skipped: 'missing_supabase_config' };
  const row = {
    agent_key: String(agentKey || 'unknown').slice(0, 120),
    summary: String(summary || '').slice(0, 1200),
    status: String(status || 'info').slice(0, 40),
    details: details && typeof details === 'object' ? details : null
  };

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/agent_activity`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: text };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'unknown_error' };
  }
}

module.exports = { logAgentActivity };

