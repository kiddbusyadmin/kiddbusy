// netlify/functions/db-proxy.js
// Minimal write proxy for admin moderation actions.

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_TABLES = {
  submissions: new Set(['pending', 'approved', 'rejected']),
  reviews: new Set(['pending', 'approved', 'rejected']),
  sponsorships: new Set(['pending', 'active', 'cancelled'])
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Lightweight caller marker used by admin.html
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { action, table, id, updates } = body;

  if (action !== 'update') {
    return json(400, { error: 'Unsupported action' });
  }

  if (!ALLOWED_TABLES[table]) {
    return json(400, { error: 'Unsupported table' });
  }

  if (!id) {
    return json(400, { error: 'Missing id' });
  }

  if (!updates || typeof updates !== 'object') {
    return json(400, { error: 'Missing updates object' });
  }

  const keys = Object.keys(updates);
  if (keys.length !== 1 || keys[0] !== 'status') {
    return json(400, { error: 'Only status updates are allowed' });
  }

  const nextStatus = String(updates.status || '');
  if (!ALLOWED_TABLES[table].has(nextStatus)) {
    return json(400, { error: 'Invalid status for table' });
  }

  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`;

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status: nextStatus })
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      return json(response.status, { error: 'Supabase update failed', details: data });
    }

    return json(200, { success: true, table, id, updates: { status: nextStatus }, data });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
