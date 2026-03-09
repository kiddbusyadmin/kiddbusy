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

  const { action, table, id, updates, match, status, limit } = body;

  if (action === 'query_submissions') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const allowedStatus = new Set(['pending', 'approved', 'rejected', 'all']);
    const statusFilter = String(status || 'all');
    if (!allowedStatus.has(statusFilter)) {
      return json(400, { error: 'Invalid status filter' });
    }

    const filters = [`select=*`, `limit=${safeLimit}`];
    if (statusFilter !== 'all') filters.push(`status=eq.${encodeURIComponent(statusFilter)}`);
    const queryUrl = `${SUPABASE_URL}/rest/v1/submissions?${filters.join('&')}`;
    try {
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      const text = await response.text();
      let data = [];
      try {
        data = text ? JSON.parse(text) : [];
      } catch {
        data = [];
      }
      if (!response.ok) {
        return json(response.status, { error: 'Supabase query failed', details: data });
      }
      return json(200, { count: Array.isArray(data) ? data.length : 0, submissions: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action !== 'update') {
    return json(400, { error: 'Unsupported action' });
  }

  if (!ALLOWED_TABLES[table]) {
    return json(400, { error: 'Unsupported table' });
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

  const buildSubmissionFilter = (m) => {
    const keys = ['business_name', 'submitter_email', 'city', 'status'];
    const parts = [];
    for (const key of keys) {
      const value = m && typeof m[key] === 'string' ? m[key].trim() : '';
      if (value) parts.push(`${key}=eq.${encodeURIComponent(value)}`);
    }
    return parts;
  };

  let filterParts = [];
  if (id) {
    filterParts = [`id=eq.${encodeURIComponent(id)}`];
  } else if (table === 'submissions') {
    filterParts = buildSubmissionFilter(match);
    if (filterParts.length < 2) {
      return json(400, { error: 'Missing id and insufficient submission match fields' });
    }
  } else {
    return json(400, { error: 'Missing id' });
  }

  const filterQuery = filterParts.join('&');
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filterQuery}`;

  try {
    // For submissions without id, require exactly one match.
    if (!id && table === 'submissions') {
      const preflight = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=business_name,submitter_email,city,status&${filterQuery}&limit=2`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      const preflightText = await preflight.text();
      let rows = [];
      try {
        rows = preflightText ? JSON.parse(preflightText) : [];
      } catch {
        rows = [];
      }
      if (!preflight.ok) {
        return json(preflight.status, { error: 'Supabase preflight failed', details: preflightText });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return json(404, { error: 'No matching submission found for update' });
      }
      if (rows.length > 1) {
        return json(409, { error: 'Ambiguous submission match; multiple rows found' });
      }
    }

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
