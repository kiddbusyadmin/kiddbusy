// netlify/functions/db-proxy.js
// Minimal write proxy for admin moderation actions.

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const { triggerSponsorshipPaymentRequestEmail } = require('./_sponsorship-payment-email');
const { buildFinanceSnapshot, upsertFinanceSnapshot } = require('./_accounting-core');

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

async function sbRequest(path, { method = 'GET', body = null, prefer = null } = {}) {
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

async function purgePlaceholderReviewsOnFirstOrganicApprove(reviewId) {
  const { response: reviewResp, data: reviewRows } = await sbRequest(
    `reviews?id=eq.${encodeURIComponent(String(reviewId))}&select=id,listing_id,source,status&limit=1`
  );
  if (!reviewResp.ok || !Array.isArray(reviewRows) || reviewRows.length === 0) return null;
  const review = reviewRows[0];
  const source = String(review.source || '').toLowerCase();
  if (!review.listing_id || source !== 'user') return null;

  const { response: organicResp, data: organicRows } = await sbRequest(
    `reviews?listing_id=eq.${encodeURIComponent(String(review.listing_id))}&status=eq.approved&source=eq.user&select=id&limit=2`
  );
  if (!organicResp.ok || !Array.isArray(organicRows) || organicRows.length !== 1) return null;

  const { response: delResp, data: delData } = await sbRequest(
    `reviews?listing_id=eq.${encodeURIComponent(String(review.listing_id))}&source=eq.ai_seed`,
    { method: 'DELETE', prefer: 'return=representation' }
  );
  if (!delResp.ok) {
    return { purge_error: true, listing_id: review.listing_id, details: delData };
  }
  return {
    listing_id: review.listing_id,
    placeholder_deleted_count: Array.isArray(delData) ? delData.length : 0
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

  const { action, table, id, updates, match, status, limit, listing_id, is_sponsored, agent_key } = body;

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

  if (action === 'update_listing_sponsor') {
    if (typeof listing_id !== 'number' && typeof listing_id !== 'string') {
      return json(400, { error: 'Missing listing_id' });
    }
    if (typeof is_sponsored !== 'boolean') {
      return json(400, { error: 'Missing is_sponsored boolean' });
    }

    const updateUrl = `${SUPABASE_URL}/rest/v1/listings?listing_id=eq.${encodeURIComponent(String(listing_id))}`;
    try {
      const response = await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ is_sponsored })
      });
      const text = await response.text();
      let data = [];
      try {
        data = text ? JSON.parse(text) : [];
      } catch {
        data = [];
      }
      if (!response.ok) {
        return json(response.status, { error: 'Supabase sponsor update failed', details: data });
      }
      if (!Array.isArray(data) || data.length === 0) {
        return json(404, { error: 'Listing not found or update not permitted' });
      }
      return json(200, { success: true, listing_id, is_sponsored, data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_agent_activity') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const filters = ['select=*', `order=created_at.desc`, `limit=${safeLimit}`];
    const key = String(agent_key || '').trim();
    if (key) filters.push(`agent_key=eq.${encodeURIComponent(key)}`);
    const queryUrl = `${SUPABASE_URL}/rest/v1/agent_activity?${filters.join('&')}`;
    try {
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, activities: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_owner_contacts') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const filters = ['select=*', 'order=created_at.desc', `limit=${safeLimit}`];
    const queryUrl = `${SUPABASE_URL}/rest/v1/owner_contact_messages?${filters.join('&')}`;
    try {
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, contacts: data });
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
    let sponsorshipBefore = null;
    if (table === 'sponsorships' && id) {
      const before = await sbRequest(`sponsorships?id=eq.${encodeURIComponent(String(id))}&select=*&limit=1`);
      if (before.response.ok && Array.isArray(before.data) && before.data.length) {
        sponsorshipBefore = before.data[0];
      }
    }

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

    let cleanup = null;
    let paymentEmail = null;
    let financeSnapshot = null;
    if (table === 'reviews' && nextStatus === 'approved') {
      cleanup = await purgePlaceholderReviewsOnFirstOrganicApprove(id);
    }
    if (table === 'sponsorships' && nextStatus === 'active') {
      const prev = String((sponsorshipBefore && sponsorshipBefore.status) || '').toLowerCase();
      const becameActive = prev !== 'active';
      if (becameActive) {
        const updated = Array.isArray(data) && data.length ? data[0] : null;
        const sponsorshipRow = updated || sponsorshipBefore || { id, status: nextStatus };
        try {
          paymentEmail = await triggerSponsorshipPaymentRequestEmail({
            sponsorship: sponsorshipRow,
            activationSource: 'manual'
          });
        } catch (emailErr) {
          paymentEmail = { sent: false, error: emailErr.message || 'Payment email failed' };
        }
      } else {
        paymentEmail = { sent: false, skipped: true, reason: 'already_active' };
      }
    }

    if (table === 'sponsorships') {
      try {
        financeSnapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      } catch (snapErr) {
        financeSnapshot = { error: snapErr.message || 'finance snapshot refresh failed' };
      }
    }

    return json(200, {
      success: true,
      table,
      id,
      updates: { status: nextStatus },
      data,
      cleanup,
      payment_email: paymentEmail,
      finance_snapshot: financeSnapshot
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
