// netlify/functions/db-proxy.js
// Minimal write proxy for admin moderation actions.

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUBMISSION_ALERT_EMAIL = process.env.SUBMISSION_ALERT_EMAIL || 'admin@kiddbusy.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const { triggerSponsorshipPaymentRequestEmail, verifySponsorshipOwnerClaim } = require('./_sponsorship-payment-email');
const { enrollClaimNurture } = require('./_sponsorship-claim-nurture');
const { buildFinanceSnapshot, upsertFinanceSnapshot } = require('./_accounting-core');
const { sendCompliantEmail } = require('./_email-compliance');
const { runCmoBlog } = require('./_cmo-blog-core');
const { runAgentConversation } = require('./_agent-router-core');
const accountantAgent = require('./accountant-agent');
const { runAgentTasks, runDelegationWatchdog } = require('./_agent-task-runner-core');

const ALLOWED_TABLES = {
  submissions: new Set(['pending', 'approved', 'rejected']),
  reviews: new Set(['pending', 'approved', 'rejected']),
  sponsorships: new Set([
    'pending',
    'pending_review',
    'approved_awaiting_payment',
    'active',
    'past_due',
    'cancel_at_period_end',
    'cancelled',
    'rejected'
  ])
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function isoAfterMinutes(minutes) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + Number(minutes || 5));
  return d.toISOString();
}

async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) throw new Error('Telegram not configured');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text || '').slice(0, 4000) })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${body}`);
  return body;
}

function humanAgentName(key) {
  const k = String(key || '').trim();
  if (k === 'president_agent') return 'President';
  if (k === 'operations_agent') return 'Operations';
  if (k === 'cmo_agent') return 'CMO';
  if (k === 'accountant_agent') return 'Accountant';
  if (k === 'research_agent') return 'Research';
  if (!k) return 'Unknown';
  return k.replace(/_/g, ' ');
}

function buildProgressText(subscription, orders, tasks) {
  const held = orders.filter((o) => String(o.status || '') === 'pending_assignment');
  const delegated = orders.filter((o) => {
    const rowStatus = String(o.status || '');
    return rowStatus === 'delegated' || rowStatus === 'in_progress';
  });
  const completed = orders.filter((o) => String(o.status || '') === 'completed');
  const lines = [];
  lines.push('President update (' + String(subscription.interval_minutes || 5) + ' min cadence)');
  lines.push('Open orders: ' + String(held.length + delegated.length) + ' | Held: ' + String(held.length) + ' | Delegated: ' + String(delegated.length) + ' | Completed tracked: ' + String(completed.length));
  if (held.length) lines.push('Held: #' + String(held[0].order_id || '') + ' ' + String(held[0].summary || held[0].title || ''));
  else lines.push('Held: no orders waiting with President.');
  if (delegated.length) {
    const d = delegated[0];
    let relatedTask = null;
    for (let i = 0; i < tasks.length; i += 1) {
      const orderId = ((tasks[i].details || {}).order_id || '');
      if (String(orderId) === String(d.order_id || '')) {
        relatedTask = tasks[i];
        break;
      }
    }
    if (relatedTask) lines.push('Delegated: ' + humanAgentName(relatedTask.assigned_agent_key) + ' on "' + String(relatedTask.title || '') + '" [' + String(relatedTask.status || '') + ']');
    else lines.push('Delegated: #' + String(d.order_id || '') + ' ' + String(d.summary || d.title || ''));
  } else {
    lines.push('Delegated: no open delegated work.');
  }
  const activeTasks = tasks.slice(0, 2).map((t) => humanAgentName(t.assigned_agent_key) + ': ' + String(t.title || '') + ' [' + String(t.status || '') + ']');
  if (activeTasks.length) lines.push('Team pulse: ' + activeTasks.join(' | '));
  else lines.push('Team pulse: no active specialist tasks.');
  lines.push('Reply to the President on Telegram to adjust cadence, pause updates, or ask for detail on any order.');
  return lines.join('\n');
}

function cleanCityName(value) {
  return String(value || '').split(',')[0].trim();
}

function extractCityFromText(value) {
  const text = String(value || '');
  const direct = text.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s*[A-Z]{2})?\b/);
  if (direct && direct[1]) return cleanCityName(direct[1]);
  const atl = text.match(/\bAtlanta\b/i);
  if (atl) return 'Atlanta';
  return '';
}

async function callInternalJson(path, { method = 'GET', body = null, source = 'kiddbusy-hq' } = {}) {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://kiddbusy.com').replace(/\/$/, '');
  const response = await fetch(base + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      source ? { 'X-Requested-From': source } : {}
    ),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error || data.message || `Internal call failed (${response.status})`);
  }
  return data;
}

async function patchTask(taskId, patch) {
  const out = await sbRequest(`agent_tasks?task_id=eq.${encodeURIComponent(String(taskId))}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function runCmoBlogTask(body) {
  const response = await runCmoBlog({
    httpMethod: 'POST',
    headers: { 'x-requested-from': 'kiddbusy-hq' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try {
    data = JSON.parse((response && response.body) || '{}');
  } catch (_) {
    data = {};
  }
  if (!response || Number(response.statusCode || 500) >= 400) {
    throw new Error(data.error || 'CMO blog task failed');
  }
  return data;
}

async function runAccountantTask(body) {
  const response = await accountantAgent.handler({
    httpMethod: 'POST',
    headers: { 'x-requested-from': 'kiddbusy-hq' },
    body: JSON.stringify(body || { action: 'run_snapshot' })
  });
  let data = {};
  try {
    data = JSON.parse((response && response.body) || '{}');
  } catch (_) {
    data = {};
  }
  if (!response || Number(response.statusCode || 500) >= 400) {
    throw new Error(data.error || 'Accountant task failed');
  }
  return data;
}

async function runDelegatedAgentTask(task, order) {
  return runAgentConversation({
    role: task.assigned_agent_key,
    userMessage:
      'Complete this delegated task from President. Task: ' + String(task.title || '') +
      '\nSummary: ' + String(task.summary || '') +
      '\nOwner request: ' + String((order && order.request_text) || '') +
      '\nIf you cannot take external action, provide a concrete completion memo with findings and next steps.',
    history: [],
    channel: 'dashboard',
    threadKey: 'task:' + String(task.task_id),
    ownerIdentity: 'harold'
  });
}

async function listCityCmoPosts(city, statuses) {
  const safeCity = encodeURIComponent(String(city || '').trim());
  if (!safeCity) return [];
  const statusList = Array.isArray(statuses) && statuses.length
    ? statuses.map((s) => String(s || '').trim()).filter(Boolean)
    : ['draft', 'published'];
  const query =
    'blog_posts?select=id,status,city,slug,title,published_at,created_at&source=eq.cmo_agent' +
    '&city=ilike.*' + safeCity + '*' +
    '&status=in.(' + statusList.map((s) => encodeURIComponent(s)).join(',') + ')' +
    '&limit=500';
  const out = await sbRequest(query, { method: 'GET' });
  return Array.isArray(out.data) ? out.data : [];
}

async function listOpenTasksByAgent(agentKey) {
  const query = 'agent_tasks?select=task_id,assigned_agent_key,status,details,title&assigned_agent_key=eq.' +
    encodeURIComponent(String(agentKey || '')) +
    '&status=in.(open,in_progress)&limit=50';
  const out = await sbRequest(query, { method: 'GET' });
  return Array.isArray(out.data) ? out.data : [];
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

function buildSubmissionApprovedAlertHtml(row) {
  const safe = row || {};
  const submittedBy = safe.submitter_name || safe.submitter_email || 'Anonymous';
  return [
    '<div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:8px 0">',
    '<p style="font-size:12px;letter-spacing:.4px;color:#6b7280;text-transform:uppercase;margin:0 0 10px">KiddBusy Approval Alert</p>',
    '<h2 style="font-size:22px;margin:0 0 12px">Listing submission approved</h2>',
    '<p style="margin:0 0 12px">A public listing submission was approved in Command Center.</p>',
    '<table style="width:100%;border-collapse:collapse;font-size:14px">',
    `<tr><td style="padding:6px 0;font-weight:700;width:170px">Business</td><td style="padding:6px 0">${safe.business_name || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Type</td><td style="padding:6px 0">${safe.type || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">City</td><td style="padding:6px 0">${safe.city || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Address</td><td style="padding:6px 0">${safe.address || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Website</td><td style="padding:6px 0">${safe.url || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Submitter</td><td style="padding:6px 0">${submittedBy}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Is owner</td><td style="padding:6px 0">${safe.is_owner ? 'yes' : 'no'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Description</td><td style="padding:6px 0">${safe.description || '--'}</td></tr>`,
    '</table>',
    '<p style="margin:16px 0 0"><a href="https://kiddbusy.com/admin.html" style="display:inline-block;background:#6c3fc5;color:#fff;text-decoration:none;padding:10px 16px;border-radius:999px;font-weight:700">Open Command Center</a></p>',
    '</div>'
  ].join('');
}

function parseListingId(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const id = Math.floor(n);
  return id > 0 ? id : null;
}

async function createSponsorshipLinkException({
  sponsorshipId = null,
  listingId = null,
  businessName = '',
  city = '',
  issueCode = 'listing_link_issue',
  issueDetail = '',
  payload = {}
} = {}) {
  await sbRequest('sponsorship_link_exceptions', {
    method: 'POST',
    body: {
      sponsorship_id: sponsorshipId ? String(sponsorshipId) : null,
      listing_id: parseListingId(listingId),
      business_name: String(businessName || '').slice(0, 200),
      city: String(city || '').slice(0, 120),
      issue_code: String(issueCode || 'listing_link_issue').slice(0, 100),
      issue_detail: String(issueDetail || '').slice(0, 600),
      status: 'open',
      payload: payload || {}
    }
  });
}

async function resolveSponsorshipListingId(sponsorshipRow) {
  const row = sponsorshipRow || {};
  const existing = parseListingId(row.listing_id);
  if (existing) return { listing_id: existing, source: 'existing' };

  const city = String(row.city || '').trim();
  const businessName = String(row.business_name || '').trim();
  if (!city || !businessName) {
    return { listing_id: null, source: 'missing_city_or_business' };
  }

  const q = `listings?select=listing_id,name,city,status&city=ilike.${encodeURIComponent(city)}&name=ilike.${encodeURIComponent(businessName)}&status=eq.active&limit=5`;
  const out = await sbRequest(q);
  if (!out.response.ok || !Array.isArray(out.data)) {
    return { listing_id: null, source: 'lookup_failed' };
  }

  const candidates = out.data.map((r) => parseListingId(r && r.listing_id)).filter(Boolean);
  if (candidates.length === 1) {
    return { listing_id: candidates[0], source: 'city_business_unique' };
  }
  if (candidates.length > 1) {
    return { listing_id: null, source: 'ambiguous', candidates };
  }
  return { listing_id: null, source: 'not_found', candidates: [] };
}

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }

  const method = String(event.httpMethod || 'GET').toUpperCase();
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  const query = event.queryStringParameters || {};
  let body = {};

  if (method === 'GET') {
    body = Object.assign({}, query);
  } else if (method === 'POST') {
    if (source !== 'kiddbusy-hq') {
      return json(403, { error: 'Forbidden' });
    }
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
  } else {
    return json(405, { error: 'Method not allowed' });
  }

  const { action, table, id, updates, match, status, limit, listing_id, is_sponsored, agent_key } = body;

  if (method === 'GET' && !['run_progress_pulse', 'run_agent_tasks'].includes(String(action || ''))) {
    return json(405, { error: 'Method not allowed' });
  }

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

  if (action === 'query_agent_tasks') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const statusFilter = String(status || '').trim().toLowerCase();
    const filters = ['select=*', 'order=updated_at.desc', `limit=${safeLimit}`];
    if (statusFilter) {
      if (statusFilter === 'open_or_in_progress') {
        filters.push('status=in.(open,in_progress)');
      } else {
        filters.push(`status=eq.${encodeURIComponent(statusFilter)}`);
      }
    }
    const queryUrl = `${SUPABASE_URL}/rest/v1/agent_tasks?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, tasks: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_owner_orders') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const statusFilter = String(status || '').trim().toLowerCase();
    const filters = ['select=*', 'order=updated_at.desc', `limit=${safeLimit}`];
    if (statusFilter) {
      if (statusFilter === 'open_funnel') {
        filters.push('status=in.(pending_assignment,delegated,in_progress,blocked)');
      } else {
        filters.push(`status=eq.${encodeURIComponent(statusFilter)}`);
      }
    }
    const queryUrl = `${SUPABASE_URL}/rest/v1/agent_orders?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, orders: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_cmo_posts') {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const filters = ['select=id,slug,title,city,status,published_at,created_at,updated_at', 'source=eq.cmo_agent', 'order=created_at.desc', `limit=${safeLimit}`];
    if (city) filters.push(`city=ilike.*${encodeURIComponent(String(city).trim())}*`);
    if (title_q) filters.push(`title=ilike.*${encodeURIComponent(String(title_q).trim())}*`);
    const queryUrl = `${SUPABASE_URL}/rest/v1/blog_posts?${filters.join('&')}`;
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
      if (!response.ok) return json(response.status, { error: 'Supabase query failed', details: data });
      return json(200, { count: Array.isArray(data) ? data.length : 0, posts: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'archive_blog_post') {
    const idNum = Number(listing_id || body.id || body.post_id || body.blog_post_id);
    if (!Number.isFinite(idNum) || idNum <= 0) return json(400, { error: 'Valid post id required' });
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts?id=eq.${encodeURIComponent(String(idNum))}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          status: 'archived',
          updated_at: nowIso()
        })
      });
      const text = await response.text();
      let data = [];
      try {
        data = text ? JSON.parse(text) : [];
      } catch {
        data = [];
      }
      if (!response.ok) return json(response.status, { error: 'Supabase update failed', details: data });
      return json(200, { success: true, post: Array.isArray(data) && data.length ? data[0] : null });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_progress_subscriptions') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const statusFilter = String(status || '').trim().toLowerCase();
    const filters = ['select=*', 'order=updated_at.desc', `limit=${safeLimit}`];
    if (statusFilter) filters.push(`status=eq.${encodeURIComponent(statusFilter)}`);
    const queryUrl = `${SUPABASE_URL}/rest/v1/agent_progress_subscriptions?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, subscriptions: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_progress_reports') {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const filters = ['select=*', 'order=created_at.desc', `limit=${safeLimit}`];
    const queryUrl = `${SUPABASE_URL}/rest/v1/agent_progress_reports?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, reports: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'run_progress_pulse') {
    try {
      const subsOut = await sbRequest(`agent_progress_subscriptions?select=*&status=eq.active&next_due_at=lte.${encodeURIComponent(nowIso())}&order=updated_at.desc&limit=50`, {
        method: 'GET'
      });
      const subs = Array.isArray(subsOut.data) ? subsOut.data : [];
      const sent = [];
      for (const sub of subs) {
        const ownerIdentity = String(sub.owner_identity || 'harold');
        const chatId = sub.target_chat_id || TELEGRAM_CHAT_ID;
        const ordersOut = await sbRequest(`agent_orders?owner_identity=eq.${encodeURIComponent(ownerIdentity)}&status=in.(pending_assignment,delegated,in_progress,blocked)&select=*&order=updated_at.desc&limit=30`, {
          method: 'GET'
        });
        const tasksOut = await sbRequest(`agent_tasks?owner_identity=eq.${encodeURIComponent(ownerIdentity)}&status=in.(open,in_progress)&select=*&order=updated_at.desc&limit=30`, {
          method: 'GET'
        });
        const orders = Array.isArray(ordersOut.data) ? ordersOut.data : [];
        const tasks = Array.isArray(tasksOut.data) ? tasksOut.data : [];
        const reportText = buildProgressText(sub, orders, tasks);
        await sendTelegramMessage(chatId, reportText);
        await sbRequest('agent_progress_reports', {
          method: 'POST',
          body: {
            subscription_id: sub.subscription_id,
            owner_identity: ownerIdentity,
            agent_key: sub.agent_key || 'president_agent',
            channel: 'telegram',
            target_chat_id: chatId,
            report_text: reportText,
            report_meta: {
              open_orders: orders.length,
              held_orders: orders.filter((o) => String(o.status || '') === 'pending_assignment').length,
              delegated_orders: orders.filter((o) => {
                const rowStatus = String(o.status || '');
                return rowStatus === 'delegated' || rowStatus === 'in_progress';
              }).length,
              open_tasks: tasks.length
            }
          }
        });
        await sbRequest(`agent_progress_subscriptions?subscription_id=eq.${encodeURIComponent(String(sub.subscription_id))}`, {
          method: 'PATCH',
          body: {
            last_sent_at: nowIso(),
            next_due_at: isoAfterMinutes(sub.interval_minutes || 5),
            summary: 'Last sent with ' + String(orders.length) + ' open orders and ' + String(tasks.length) + ' open tasks.',
            updated_at: nowIso()
          }
        });
        await sbRequest('agent_activity', {
          method: 'POST',
          body: {
            agent_key: sub.agent_key || 'president_agent',
            summary: 'Progress update sent to Telegram for subscription ' + String(sub.subscription_id) + '.',
            status: 'success',
            details: {
              subscription_id: sub.subscription_id,
              channel: 'telegram',
              scope: sub.scope || 'all_open_orders'
            }
          }
        });
        sent.push({ subscription_id: sub.subscription_id, chat_id: chatId });
      }
      return json(200, { success: true, due: subs.length, sent });
    } catch (err) {
      try {
        await sbRequest('agent_activity', {
          method: 'POST',
          body: {
            agent_key: 'president_agent',
            summary: 'Progress pulse failed: ' + String(err.message || 'unknown error').slice(0, 800),
            status: 'error',
            details: { run_type: 'db_proxy_progress_pulse' }
          }
        });
      } catch (_) {}
      return json(500, { error: err.message || 'Progress pulse failed' });
    }
  }

  if (action === 'run_agent_tasks') {
    try {
      const result = await runAgentTasks();
      const watchdog = await runDelegationWatchdog();
      return json(200, { success: !!(result && result.success && watchdog && watchdog.success), tasks: result, watchdog: watchdog });
    } catch (err) {
      try {
        await sbRequest('agent_activity', {
          method: 'POST',
          body: {
            agent_key: 'president_agent',
            summary: 'Agent task runner failed: ' + String(err.message || 'unknown error').slice(0, 800),
            status: 'error',
            details: { run_type: 'agent_task_runner' }
          }
        });
      } catch (_) {}
      return json(500, { error: err.message || 'Agent task runner failed' });
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

  if (action === 'query_sponsorship_lifecycle') {
    const safeLimit = Math.min(Math.max(Number(limit) || 300, 1), 1000);
    const filters = ['select=*', 'order=created_at.desc', `limit=${safeLimit}`];
    const queryUrl = `${SUPABASE_URL}/rest/v1/sponsorships?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, sponsorships: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_stripe_events') {
    const safeLimit = Math.min(Math.max(Number(limit) || 150, 1), 500);
    const filters = ['select=*', 'order=created_at.desc', `limit=${safeLimit}`];
    const queryUrl = `${SUPABASE_URL}/rest/v1/stripe_events?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, events: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'query_sponsorship_exceptions') {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const statusFilter = String((body && body.status_filter) || 'open').trim().toLowerCase();
    const filters = ['select=*', 'order=created_at.desc', `limit=${safeLimit}`];
    if (statusFilter && statusFilter !== 'all') filters.push(`status=eq.${encodeURIComponent(statusFilter)}`);
    const queryUrl = `${SUPABASE_URL}/rest/v1/sponsorship_link_exceptions?${filters.join('&')}`;
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
      return json(200, { count: Array.isArray(data) ? data.length : 0, exceptions: data });
    } catch (err) {
      return json(500, { error: err.message || 'Unexpected error' });
    }
  }

  if (action === 'resolve_sponsorship_exception') {
    const exceptionId = body && body.exception_id != null ? Number(body.exception_id) : null;
    const listingId = body && body.listing_id != null ? parseListingId(body.listing_id) : null;
    const resolutionNote = String((body && body.resolution_note) || '').slice(0, 500);
    if (!Number.isFinite(exceptionId) || exceptionId <= 0) {
      return json(400, { error: 'exception_id is required' });
    }

    try {
      const ex = await sbRequest(`sponsorship_link_exceptions?exception_id=eq.${encodeURIComponent(String(exceptionId))}&select=*&limit=1`);
      if (!ex.response.ok || !Array.isArray(ex.data) || !ex.data.length) {
        return json(404, { error: 'Exception not found' });
      }
      const row = ex.data[0] || {};
      const sponsorshipId = row.sponsorship_id ? String(row.sponsorship_id) : null;
      if (sponsorshipId && listingId) {
        await sbRequest(`sponsorships?id=eq.${encodeURIComponent(sponsorshipId)}`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: { listing_id: listingId }
        });
      }
      const patch = await sbRequest(`sponsorship_link_exceptions?exception_id=eq.${encodeURIComponent(String(exceptionId))}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: {
          status: 'resolved',
          listing_id: listingId || parseListingId(row.listing_id),
          resolved_at: new Date().toISOString(),
          resolved_by: 'command_center',
          resolution_note: resolutionNote || (listingId ? `Linked to listing_id=${listingId}` : 'Resolved')
        }
      });
      if (!patch.response.ok) {
        return json(patch.response.status, { error: 'Failed to resolve exception', details: patch.data });
      }
      return json(200, { success: true, exception: Array.isArray(patch.data) ? patch.data[0] : patch.data });
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
    let sponsorshipLinking = null;
    let claimNurture = null;
    let submissionBefore = null;
    if (table === 'sponsorships' && id) {
      const before = await sbRequest(`sponsorships?id=eq.${encodeURIComponent(String(id))}&select=*&limit=1`);
      if (before.response.ok && Array.isArray(before.data) && before.data.length) {
        sponsorshipBefore = before.data[0];
      }
    }
    if (table === 'submissions' && id) {
      const before = await sbRequest(`submissions?id=eq.${encodeURIComponent(String(id))}&select=*&limit=1`);
      if (before.response.ok && Array.isArray(before.data) && before.data.length) {
        submissionBefore = before.data[0];
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

    const patchBody = { status: nextStatus };
    if (table === 'sponsorships' && nextStatus === 'approved_awaiting_payment' && sponsorshipBefore) {
      sponsorshipLinking = await resolveSponsorshipListingId(sponsorshipBefore);
      if (parseListingId(sponsorshipLinking && sponsorshipLinking.listing_id)) {
        patchBody.listing_id = parseListingId(sponsorshipLinking.listing_id);
      } else {
        await createSponsorshipLinkException({
          sponsorshipId: sponsorshipBefore.id,
          listingId: sponsorshipBefore.listing_id,
          businessName: sponsorshipBefore.business_name,
          city: sponsorshipBefore.city,
          issueCode: (sponsorshipLinking && sponsorshipLinking.source === 'ambiguous') ? 'listing_ambiguous' : 'listing_not_found',
          issueDetail: (sponsorshipLinking && sponsorshipLinking.source === 'ambiguous')
            ? 'Multiple active listings matched while approving sponsorship for payment.'
            : 'No active listing matched while approving sponsorship for payment.',
          payload: { candidates: sponsorshipLinking && sponsorshipLinking.candidates ? sponsorshipLinking.candidates : [] }
        });
      }

      const prePatchSponsorship = Object.assign({}, sponsorshipBefore, {
        listing_id: parseListingId(patchBody.listing_id) || parseListingId(sponsorshipBefore.listing_id)
      });
      const claimCheck = await verifySponsorshipOwnerClaim(prePatchSponsorship);
      if (!claimCheck.ok) {
        await createSponsorshipLinkException({
          sponsorshipId: sponsorshipBefore.id,
          listingId: prePatchSponsorship.listing_id,
          businessName: sponsorshipBefore.business_name,
          city: sponsorshipBefore.city,
          issueCode: claimCheck.reason || 'owner_claim_required',
          issueDetail: 'Sponsorship approval blocked: business owner must claim and verify listing before payment.',
          payload: { owner_email: sponsorshipBefore.email || null }
        });
        try {
          claimNurture = await enrollClaimNurture({
            sponsorship: prePatchSponsorship,
            reason: claimCheck.reason || 'owner_claim_required',
            source: 'db_proxy_status_update_blocked'
          });
        } catch (enrollErr) {
          claimNurture = { enrolled: false, reason: 'enroll_failed', error: enrollErr.message || 'unknown_error' };
        }
        return json(409, {
          error: 'Owner claim required before sponsorship payment',
          reason: claimCheck.reason || 'owner_claim_required',
          sponsorship_id: sponsorshipBefore.id,
          listing_id: prePatchSponsorship.listing_id || null,
          nurture: claimNurture
        });
      }
    }
    if (table === 'sponsorships' && nextStatus === 'approved_awaiting_payment') {
      patchBody.approved_at = new Date().toISOString();
      patchBody.payment_error = null;
    }
    if (table === 'sponsorships' && (nextStatus === 'cancelled' || nextStatus === 'past_due')) {
      patchBody.canceled_at = nextStatus === 'cancelled' ? new Date().toISOString() : null;
    }

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(patchBody)
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
    let submissionApprovalEmail = null;
    if (table === 'reviews' && nextStatus === 'approved') {
      cleanup = await purgePlaceholderReviewsOnFirstOrganicApprove(id);
    }
    if (table === 'submissions' && nextStatus === 'approved') {
      const prev = String((submissionBefore && submissionBefore.status) || '').toLowerCase();
      const approvedRow = Array.isArray(data) && data.length ? data[0] : (submissionBefore || {});
      if (prev !== 'approved') {
        try {
          submissionApprovalEmail = await sendCompliantEmail({
            to: SUBMISSION_ALERT_EMAIL,
            subject: `Submission approved: ${approvedRow.business_name || 'Listing'} (${approvedRow.city || 'Unknown city'})`,
            body: buildSubmissionApprovedAlertHtml(approvedRow),
            fromName: 'KiddBusy Alerts',
            campaignType: 'submission_approval_alert',
            allowSuppressedBypass: true
          });
        } catch (emailErr) {
          submissionApprovalEmail = { sent: false, error: emailErr.message || 'Approval email failed' };
        }
      } else {
        submissionApprovalEmail = { sent: false, skipped: true, reason: 'already_approved' };
      }
    }
    if (table === 'sponsorships' && nextStatus === 'approved_awaiting_payment') {
      const prev = String((sponsorshipBefore && sponsorshipBefore.status) || '').toLowerCase();
      const shouldSendPayment = prev !== 'approved_awaiting_payment' && prev !== 'active' && prev !== 'cancel_at_period_end';
      const linkedListingId = parseListingId((Array.isArray(data) && data.length ? data[0] : sponsorshipBefore || {}).listing_id);
      if (shouldSendPayment) {
        if (!linkedListingId) {
          paymentEmail = { sent: false, skipped: true, reason: 'listing_link_required', detail: 'Resolve sponsorship link exception before sending payment link' };
        } else {
          const updated = Array.isArray(data) && data.length ? data[0] : null;
          const sponsorshipRow = updated || sponsorshipBefore || { id, status: nextStatus, approved_at: new Date().toISOString() };
          try {
            paymentEmail = await triggerSponsorshipPaymentRequestEmail({
              sponsorship: sponsorshipRow,
              activationSource: 'manual'
            });
          } catch (emailErr) {
            paymentEmail = { sent: false, error: emailErr.message || 'Payment email failed' };
          }
        }
      } else {
        paymentEmail = { sent: false, skipped: true, reason: 'already_approved_or_active' };
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
      submission_approval_email: submissionApprovalEmail,
      sponsorship_linking: sponsorshipLinking,
      payment_email: paymentEmail,
      finance_snapshot: financeSnapshot
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
