const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const { logAgentActivity } = require('./_agent-activity');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, data };
}

exports.handler = async (event) => {
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }

  if (event.httpMethod === 'GET') {
    const { response, data } = await sbFetch('cmo_agent_settings?id=eq.1&select=*');
    if (!response.ok) return json(response.status, { error: 'Failed to read CMO config', details: data });
    const row = Array.isArray(data) && data.length ? data[0] : null;
    return json(200, { success: true, config: row });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const allowed = [
    'execution_mode',
    'auto_send_enabled',
    'max_emails_per_day',
    'monthly_email_send_cap',
    'contact_cap',
    'blog_queue_target_per_day',
    'blog_distribution_enabled',
    'blog_publish_rate_per_day',
    'instagram_handle',
    'instagram_mode',
    'instagram_profile_ready',
    'instagram_notifications_ready',
    'instagram_kickoff_posts_target',
    'instagram_daily_posts_target',
    'updated_at'
  ];
  const patch = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
  }
  patch.updated_at = new Date().toISOString();

  const { response, data } = await sbFetch('cmo_agent_settings?id=eq.1', {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  if (!response.ok) return json(response.status, { error: 'Failed to update CMO config', details: data });

  const row = Array.isArray(data) && data.length ? data[0] : null;
  await logAgentActivity({
    agentKey: 'cmo_agent',
    status: 'info',
    summary: `CMO config updated: execution_mode=${row && row.execution_mode ? row.execution_mode : 'unknown'}, auto_send=${row && row.auto_send_enabled ? 'on' : 'off'}.`,
    details: {
      execution_mode: row ? row.execution_mode : null,
      auto_send_enabled: row ? !!row.auto_send_enabled : null,
      max_emails_per_day: row ? row.max_emails_per_day : null,
      monthly_email_send_cap: row ? row.monthly_email_send_cap : null,
      contact_cap: row ? row.contact_cap : null,
      blog_queue_target_per_day: row ? row.blog_queue_target_per_day : null,
      blog_distribution_enabled: row ? !!row.blog_distribution_enabled : null,
      blog_publish_rate_per_day: row ? row.blog_publish_rate_per_day : null,
      instagram_handle: row ? row.instagram_handle : null,
      instagram_mode: row ? row.instagram_mode : null,
      instagram_profile_ready: row ? !!row.instagram_profile_ready : null,
      instagram_notifications_ready: row ? !!row.instagram_notifications_ready : null,
      instagram_kickoff_posts_target: row ? row.instagram_kickoff_posts_target : null,
      instagram_daily_posts_target: row ? row.instagram_daily_posts_target : null
    }
  });
  return json(200, { success: true, config: row });
};
