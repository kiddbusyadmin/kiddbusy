// netlify/functions/telegram-webhook.js
// Receives messages from Telegram, runs the KiddBusy agent, replies

const SUPABASE_URL = process.env.KB_DB_URL || 'https://wgwexzyqaiwosgraaczi.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_AGENT_MODEL = process.env.TELEGRAM_AGENT_MODEL || 'claude-haiku-4-5-20251001';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // your personal chat ID
const { sendCompliantEmail } = require('./_email-compliance');
const { triggerSponsorshipPaymentRequestEmail } = require('./_sponsorship-payment-email');
const { buildFinanceSnapshot, upsertFinanceSnapshot, addManualEntry } = require('./_accounting-core');
const { runAgentConversation } = require('./_agent-router-core');

// ---- TELEGRAM ----
async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    })
  });
  return res.json();
}

// ---- SUPABASE ----
async function dbQuery(table, params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(params.select || '*')}&limit=${Math.min(Math.max(Number(params.limit) || 100, 1), 1000)}`;
  if (params.eq) {
    for (const [col, val] of Object.entries(params.eq)) {
      url += `&${col}=eq.${encodeURIComponent(val)}`;
    }
  }
  if (params.in) {
    for (const [col, vals] of Object.entries(params.in)) {
      const arr = Array.isArray(vals) ? vals : [];
      if (!arr.length) continue;
      const packed = arr.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
      url += `&${col}=in.(${encodeURIComponent(packed)})`;
    }
  }
  if (params.order) {
    const by = String(params.order.by || 'created_at');
    const asc = params.order.asc ? 'asc' : 'desc';
    url += `&order=${encodeURIComponent(by)}.${asc}`;
  }
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB query failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

function isWithinRange(ts, rangeKey) {
  if (!ts) return false;
  if (rangeKey === 'all') return true;
  const nowMs = Date.now();
  const tMs = new Date(ts).getTime();
  if (!Number.isFinite(tMs)) return false;
  const delta = nowMs - tMs;
  if (rangeKey === '24h') return delta <= 24 * 60 * 60 * 1000;
  if (rangeKey === '7d') return delta <= 7 * 24 * 60 * 60 * 1000;
  if (rangeKey === '30d') return delta <= 30 * 24 * 60 * 60 * 1000;
  return true;
}

async function queryOwnerKpis() {
  const [events, claims, changes] = await Promise.all([
    dbQuery('analytics', { limit: 2000, order: { by: 'created_at', asc: false } }),
    dbQuery('owner_claims', { select: 'status,owner_email,listing_id,created_at', limit: 500, order: { by: 'created_at', asc: false } }),
    dbQuery('owner_change_requests', { select: 'status,change_type,created_at', limit: 500, order: { by: 'created_at', asc: false } })
  ]);
  const ownerEvents = (events || []).filter((e) => String(e.event || '').startsWith('owner_'));
  const counts = {};
  ownerEvents.forEach((e) => { counts[e.event] = (counts[e.event] || 0) + 1; });
  const starts = counts.owner_claim_start || 0;
  const verified = counts.owner_claim_verified || 0;
  const abandons = counts.owner_claim_abandon || 0;
  const updates = counts.owner_update_saved || 0;
  const conversionPercent = starts > 0 ? Math.round((verified / starts) * 100) : 0;
  const abandonPercent = starts > 0 ? Math.round((abandons / starts) * 100) : 0;
  return {
    starts,
    verified,
    abandons,
    updates,
    conversion_percent: conversionPercent,
    abandon_percent: abandonPercent,
    claims_count: (claims || []).length,
    changes_count: (changes || []).length
  };
}

async function queryDashboardStats(range = '24h') {
  const safeRange = ['24h', '7d', '30d', 'all'].includes(String(range)) ? String(range) : '24h';
  const [events, reviews, emailLeads, submissions, cacheHits, cacheMisses] = await Promise.all([
    dbQuery('analytics', { select: 'event,city,created_at,value,session_id', limit: 4000, order: { by: 'created_at', asc: false } }),
    dbQuery('reviews', { select: 'status,created_at', limit: 2000, order: { by: 'created_at', asc: false } }),
    dbQuery('email_leads', { select: 'created_at,city,source', limit: 2000, order: { by: 'created_at', asc: false } }),
    dbQuery('submissions', { select: 'status,created_at,city', limit: 2000, order: { by: 'created_at', asc: false } }),
    dbQuery('analytics', { select: 'created_at', eq: { event: 'cache_hit' }, limit: 2000, order: { by: 'created_at', asc: false } }),
    dbQuery('analytics', { select: 'created_at', eq: { event: 'cache_miss' }, limit: 2000, order: { by: 'created_at', asc: false } })
  ]);

  const scopedEvents = (events || []).filter((e) => isWithinRange(e.created_at, safeRange));
  const searchAll = (events || []).filter((e) => e.event === 'city_search');
  const searchScoped = scopedEvents.filter((e) => e.event === 'city_search');
  const uniqueCitiesScoped = new Set(searchScoped.map((e) => e.city).filter(Boolean)).size;
  const uniqueCitiesAll = new Set(searchAll.map((e) => e.city).filter(Boolean)).size;
  const multiCityScoped = scopedEvents.filter((e) => e.event === 'multi_city_session').length;
  const multiCityAll = (events || []).filter((e) => e.event === 'multi_city_session').length;
  const emailScoped = (emailLeads || []).filter((e) => isWithinRange(e.created_at, safeRange)).length;
  const reviewScopedRows = (reviews || []).filter((r) => isWithinRange(r.created_at, safeRange));
  const submissionScopedRows = (submissions || []).filter((s) => isWithinRange(s.created_at, safeRange));
  const advScoped = scopedEvents.filter((e) => e.event === 'advertise_click').length;
  const advAll = (events || []).filter((e) => e.event === 'advertise_click').length;
  const hitsScoped = (cacheHits || []).filter((r) => isWithinRange(r.created_at, safeRange)).length;
  const missesScoped = (cacheMisses || []).filter((r) => isWithinRange(r.created_at, safeRange)).length;
  const hitsAll = (cacheHits || []).length;
  const missesAll = (cacheMisses || []).length;
  const cachePctScoped = (hitsScoped + missesScoped) > 0 ? Math.round((hitsScoped / (hitsScoped + missesScoped)) * 100) : null;
  const cachePctAll = (hitsAll + missesAll) > 0 ? Math.round((hitsAll / (hitsAll + missesAll)) * 100) : null;

  return {
    range: safeRange,
    searches: { scoped: searchScoped.length, all_time: searchAll.length },
    unique_cities: { scoped: uniqueCitiesScoped, all_time: uniqueCitiesAll },
    multi_city_sessions: { scoped: multiCityScoped, all_time: multiCityAll },
    email_leads: { scoped: emailScoped, all_time: (emailLeads || []).length },
    reviews: { scoped: reviewScopedRows.length, all_time: (reviews || []).length, pending_all_time: (reviews || []).filter((r) => r.status === 'pending').length },
    submissions: { scoped: submissionScopedRows.length, all_time: (submissions || []).length, pending_all_time: (submissions || []).filter((s) => s.status === 'pending').length },
    advertise_clicks: { scoped: advScoped, all_time: advAll },
    cache_hit_rate: { scoped_percent: cachePctScoped, all_time_percent: cachePctAll }
  };
}

async function dbUpdate(table, id, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) throw new Error(`DB update failed (${res.status}): ${await res.text()}`);
  return { success: true };
}

async function purgePlaceholderReviewsOnFirstOrganicApprove(reviewId) {
  const reviewRows = await dbQuery('reviews', {
    select: 'id,listing_id,source,status',
    eq: { id: reviewId },
    limit: 1
  });
  const review = Array.isArray(reviewRows) && reviewRows.length ? reviewRows[0] : null;
  if (!review || !review.listing_id || String(review.source || '').toLowerCase() !== 'user') return null;

  const organicRows = await dbQuery('reviews', {
    select: 'id',
    eq: { listing_id: review.listing_id, status: 'approved', source: 'user' },
    limit: 2
  });
  if (!Array.isArray(organicRows) || organicRows.length !== 1) return null;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/reviews?listing_id=eq.${encodeURIComponent(String(review.listing_id))}&source=eq.ai_seed`,
    {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      }
    }
  );
  const text = await res.text();
  let data = [];
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = [];
  }
  if (!res.ok) throw new Error(`Placeholder review purge failed (${res.status})`);
  return { listing_id: review.listing_id, placeholder_deleted_count: Array.isArray(data) ? data.length : 0 };
}

// ---- EMAIL ----
async function sendEmail(to, subject, body, fromName = 'KiddBusy') {
  return sendCompliantEmail({
    to,
    subject,
    body,
    fromName,
    campaignType: 'telegram_agent'
  });
}

// ---- TOOL EXECUTOR ----
async function executeTool(name, input) {
  switch (name) {
    case 'query_submissions': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('submissions', { eq });
      return { count: data.length, submissions: data };
    }
    case 'query_reviews': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('reviews', { eq });
      return { count: data.length, reviews: data };
    }
    case 'query_sponsorships': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('sponsorships', { eq });
      return { count: data.length, sponsorships: data };
    }
    case 'query_listings': {
      const eq = {};
      if (input.status) eq.status = input.status;
      const data = await dbQuery('listings', { eq, limit: input.limit || 200, order: { by: 'last_refreshed', asc: false } });
      return { count: data.length, listings: data };
    }
    case 'query_submission_photos': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const data = await dbQuery('submission_photos', { eq, limit: input.limit || 200, order: { by: 'created_at', asc: false } });
      return { count: data.length, photos: data };
    }
    case 'query_email_leads': {
      const eq = {};
      if (input.city) eq.city = input.city;
      const data = await dbQuery('email_leads', { eq, limit: input.limit || 500, order: { by: 'created_at', asc: false } });
      return { count: data.length, leads: data };
    }
    case 'query_analytics': {
      const eq = {};
      if (input.event) eq.event = input.event;
      if (input.city) eq.city = input.city;
      const data = await dbQuery('analytics', { eq, limit: input.limit || 1000, order: { by: 'created_at', asc: false } });
      return { count: data.length, analytics: data };
    }
    case 'query_owner_kpis':
      return queryOwnerKpis();
    case 'query_cmo_settings': {
      const data = await dbQuery('cmo_agent_settings', { eq: { id: 1 }, limit: 1 });
      return { config: data[0] || null };
    }
    case 'query_agent_activity': {
      const eq = {};
      if (input.agent_key) eq.agent_key = input.agent_key;
      if (input.status) eq.status = input.status;
      const data = await dbQuery('agent_activity', { eq, limit: input.limit || 200, order: { by: 'created_at', asc: false } });
      return { count: data.length, activities: data };
    }
    case 'query_email_compliance': {
      const [prefs, logs] = await Promise.all([
        dbQuery('email_preferences', { limit: input.limit || 500, order: { by: 'updated_at', asc: false } }),
        dbQuery('email_send_log', { limit: input.limit || 500, order: { by: 'created_at', asc: false } })
      ]);
      return {
        unsubscribed_count: (prefs || []).filter((p) => !!p.unsubscribed).length,
        send_log_count: (logs || []).length,
        failed_count: (logs || []).filter((l) => String(l.status || '').toLowerCase() === 'failed').length,
        suppressed_count: (logs || []).filter((l) => String(l.status || '').toLowerCase() === 'suppressed_unsubscribed').length,
        prefs,
        logs
      };
    }
    case 'query_dashboard_stats':
      return queryDashboardStats(input.range || '24h');
    case 'query_finance_snapshot': {
      const preview = await buildFinanceSnapshot();
      return { snapshot: preview };
    }
    case 'run_accountant_snapshot': {
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      return { success: true, snapshot };
    }
    case 'add_finance_manual_entry': {
      const entry = await addManualEntry({
        kind: input.kind,
        amount: input.amount,
        category: input.category,
        vendor: input.vendor,
        notes: input.notes,
        entry_date: input.entry_date,
        source: 'telegram_agent'
      });
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      return { success: true, entry, snapshot };
    }
    case 'update_submission_status':
      await dbUpdate('submissions', input.id, { status: input.status });
      return { success: true, id: input.id, new_status: input.status };
    case 'update_review_status':
      await dbUpdate('reviews', input.id, { status: input.status });
      if (input.status === 'approved') {
        const cleanup = await purgePlaceholderReviewsOnFirstOrganicApprove(input.id);
        return { success: true, id: input.id, new_status: input.status, cleanup };
      }
      return { success: true, id: input.id, new_status: input.status };
    case 'update_sponsorship_status':
      var beforeRows = await dbQuery('sponsorships', { eq: { id: input.id }, limit: 1 });
      var before = Array.isArray(beforeRows) && beforeRows.length ? beforeRows[0] : null;
      await dbUpdate('sponsorships', input.id, { status: input.status });
      var paymentEmail = null;
      if (String(input.status || '').toLowerCase() === 'approved_awaiting_payment') {
        var prev = String((before && before.status) || '').toLowerCase();
        if (prev !== 'approved_awaiting_payment' && prev !== 'active' && prev !== 'cancel_at_period_end') {
          try {
            paymentEmail = await triggerSponsorshipPaymentRequestEmail({
              sponsorship: Object.assign({}, before || {}, { id: input.id, status: 'approved_awaiting_payment' }),
              activationSource: 'telegram_agent'
            });
          } catch (emailErr) {
            paymentEmail = { sent: false, error: emailErr.message || 'Payment email failed' };
          }
        } else {
          paymentEmail = { sent: false, skipped: true, reason: 'already_approved_or_active' };
        }
      }
      var financeSnapshot = null;
      try {
        financeSnapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      } catch (snapErr) {
        financeSnapshot = { error: snapErr.message || 'finance snapshot refresh failed' };
      }
      return { success: true, id: input.id, new_status: input.status, payment_email: paymentEmail, finance_snapshot: financeSnapshot };
    }
    case 'send_email':
      await sendEmail(input.to, input.subject, input.body, input.from_name || 'KiddBusy');
      return { success: true, to: input.to };
    case 'send_telegram': {
      const chatId = TELEGRAM_ALLOWED_CHAT_ID;
      await sendTelegram(chatId, input.message);
      return { success: true };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- SHARED AGENT ROUTER ----
async function runAgent(userMessage) {
  const result = await runAgentConversation({
    role: 'president_agent',
    userMessage,
    history: [],
    channel: 'telegram'
  });
  const label = result && result.agent_name ? `[${result.agent_name}] ` : '';
  return `${label}${result.reply || ''}`.trim();
}

// ---- NETLIFY HANDLER ----
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'OK' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: 'OK' };
  }

  const message = body.message;
  if (!message) return { statusCode: 200, body: 'OK' };

  const chatId = String(message.chat.id);
  const text = message.text || '';

  // Security: only respond to your chat ID
  if (TELEGRAM_ALLOWED_CHAT_ID && chatId !== TELEGRAM_ALLOWED_CHAT_ID) {
    await sendTelegram(chatId, 'Unauthorized.');
    return { statusCode: 200, body: 'OK' };
  }

  // Acknowledge immediately (Telegram has a 5s timeout)
  // Run agent async — we'll send the response via sendTelegram
  try {
    await sendTelegram(chatId, '⏳ On it...');
    const reply = await runAgent(text);
    await sendTelegram(chatId, reply);
  } catch (err) {
    await sendTelegram(chatId, `❌ Error: ${err.message}`);
  }

  return { statusCode: 200, body: 'OK' };
};
