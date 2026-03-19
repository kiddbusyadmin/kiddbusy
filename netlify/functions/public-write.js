const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST,OPTIONS'
    },
    body: JSON.stringify(payload)
  };
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max || 300);
}

function normalizeWebsiteUrl(value) {
  const raw = cleanText(value, 400);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return 'https://' + raw.replace(/^\/+/, '');
}

function normalizeCityBase(value) {
  return String(value || '').split(',')[0].trim();
}

function normalizeState(value) {
  const raw = cleanText(value, 120);
  return raw || '';
}

function normalizeAddress(value) {
  return cleanText(value, 240)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bparkway\b/g, 'pkwy');
}

function canonicalName(value) {
  return cleanText(value, 240)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|inc|llc|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicate(a, b) {
  const aCanon = canonicalName(a && a.name);
  const bCanon = canonicalName(b && b.name);
  if (!aCanon || !bCanon) return false;
  if (aCanon === bCanon) return true;
  if (aCanon.includes(bCanon) || bCanon.includes(aCanon)) return true;
  const aAddr = normalizeAddress(a && a.address);
  const bAddr = normalizeAddress(b && b.address);
  if (aAddr && bAddr && (aAddr === bAddr || aAddr.includes(bAddr) || bAddr.includes(aAddr))) {
    const aTokens = new Set(aCanon.split(' ').filter(Boolean));
    const bTokens = new Set(bCanon.split(' ').filter(Boolean));
    const inter = Array.from(aTokens).filter((t) => bTokens.has(t)).length;
    const union = new Set([].concat(Array.from(aTokens), Array.from(bTokens))).size || 1;
    return (inter / union) >= 0.6;
  }
  return false;
}

async function sbRequest(path, { method = 'GET', body = null, prefer = 'return=representation' } = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { response, data };
}

async function insertAnalytics(input) {
  const row = {
    event: cleanText(input.event, 120),
    city: cleanText(input.city, 120) || null,
    value: input.value == null ? null : (typeof input.value === 'string' ? input.value.slice(0, 2000) : JSON.stringify(input.value).slice(0, 2000)),
    session_id: cleanText(input.session_id, 160),
    is_internal: !!input.is_internal,
    source: cleanText(input.source, 40) || 'public',
    user_agent: cleanText(input.user_agent, 500) || null,
    path: cleanText(input.path, 300) || null
  };
  if (!row.event || !row.session_id) return { skipped: 'invalid_payload' };
  const out = await sbRequest('analytics', { method: 'POST', body: row });
  if (!out.response.ok) throw new Error('analytics insert failed');
  return { success: true };
}

async function upsertCitySearch(input) {
  const city = cleanText(input.city, 120);
  if (!city) return { skipped: 'missing_city' };
  const out = await sbRequest('city_searches?on_conflict=city', {
    method: 'POST',
    body: { city, last_searched: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!out.response.ok) throw new Error('city_searches upsert failed');
  return { success: true };
}

async function captureEmailLead(input) {
  const email = cleanText(input.email, 200).toLowerCase();
  const city = cleanText(input.city, 120) || 'Unknown';
  const source = cleanText(input.source, 80) || 'homepage_signup';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid email');
  const out = await sbRequest('email_leads', { method: 'POST', body: { email, city, source } });
  if (!out.response.ok && !(out.data && String(out.data.code || '') === '23505')) throw new Error('email lead insert failed');
  return { success: true };
}

async function recomputeListingReviewSnapshot(listingId) {
  const id = Number(listingId || 0);
  if (!Number.isFinite(id) || id <= 0) return;
  const reviewsOut = await sbRequest(`reviews?listing_id=eq.${encodeURIComponent(String(id))}&status=eq.approved&select=rating,source`);
  if (!reviewsOut.response.ok || !Array.isArray(reviewsOut.data)) return;
  const nonAi = reviewsOut.data.filter((r) => String((r && r.source) || '').toLowerCase() !== 'ai_seed');
  const count = nonAi.length;
  const avg = count ? (nonAi.reduce((sum, r) => sum + (Number(r && r.rating) || 0), 0) / count) : null;
  await sbRequest(`listings?listing_id=eq.${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: {
      review_count: count,
      rating: count ? Math.round(avg * 10) / 10 : null
    }
  });
}

async function submitReview(input) {
  const row = {
    listing_id: Number(input.listing_id || 0),
    reviewer_name: cleanText(input.reviewer_name, 180),
    rating: Number(input.rating || 0),
    review_text: cleanText(input.review_text, 2000) || null,
    age_range: cleanText(input.age_range, 120) || null,
    reviewer_email: cleanText(input.reviewer_email, 200).toLowerCase() || null,
    status: cleanText(input.status, 40) || 'approved',
    source: cleanText(input.source, 40) || 'user'
  };
  if (!Number.isFinite(row.listing_id) || row.listing_id <= 0) throw new Error('invalid listing_id');
  if (!row.reviewer_name || !Number.isFinite(row.rating) || row.rating < 1 || row.rating > 5) throw new Error('invalid review payload');
  const out = await sbRequest('reviews', { method: 'POST', body: row });
  if (!out.response.ok) throw new Error('review insert failed');
  await recomputeListingReviewSnapshot(row.listing_id);
  return { success: true, review: Array.isArray(out.data) ? out.data[0] : out.data };
}

async function replaceCityEvents(input) {
  const city = cleanText(input.city, 120);
  const rowsIn = Array.isArray(input.rows) ? input.rows : [];
  if (!city || !rowsIn.length) throw new Error('invalid events payload');
  const del = await sbRequest(`events?city=ilike.${encodeURIComponent(city)}`, { method: 'DELETE' });
  if (!del.response.ok) throw new Error('event delete failed');
  const stamp = new Date().toISOString();
  const rows = rowsIn.map((e) => ({
    city,
    month: cleanText(e.month, 40) || null,
    day: cleanText(e.day, 40) || null,
    name: cleanText(e.name, 240),
    detail: cleanText(e.detail, 2000) || null,
    is_free: !!e.is_free,
    source_url: cleanText(e.source_url, 500) || null,
    ongoing: !!e.ongoing,
    start_date: cleanText(e.start_date, 20) || null,
    end_date: cleanText(e.end_date, 20) || null,
    last_refreshed: stamp
  })).filter((r) => r.name);
  const out = await sbRequest('events', { method: 'POST', body: rows });
  if (!out.response.ok) throw new Error('event insert failed');
  return { success: true, count: rows.length };
}

async function upsertListing(input) {
  const activity = input.activity || {};
  const cityRaw = cleanText(input.city, 120);
  const source = cleanText(input.source, 80) || 'ai_generated';
  const cityName = normalizeCityBase(cityRaw);
  const cityParts = cityRaw.split(',');
  const stateName = normalizeState(cityParts[1] || input.state || '');
  if (!cityName || !cleanText(activity.name, 240)) throw new Error('invalid listing payload');

  const rowsOut = await sbRequest(`listings?select=listing_id,name,address,city,status,last_refreshed&city=ilike.${encodeURIComponent(cityName)}&status=eq.active&limit=400`);
  const cityRows = Array.isArray(rowsOut.data) ? rowsOut.data : [];
  const probe = { name: activity.name, address: activity.addr };
  const existing = cityRows.find((r) => isNearDuplicate(probe, r)) || null;
  const website = normalizeWebsiteUrl(activity.website);
  const now = new Date().toISOString();

  if (existing) {
    const updatePayload = {
      name: cleanText(activity.name, 240),
      category: cleanText(activity.category, 120) || null,
      description: cleanText(activity.desc, 2000) || null,
      address: cleanText(activity.addr, 240) || null,
      is_open: Object.prototype.hasOwnProperty.call(activity, 'open') ? !!activity.open : true,
      last_refreshed: now,
      source: source
    };
    if (website) updatePayload.website = website;
    const up = await sbRequest(`listings?listing_id=eq.${encodeURIComponent(String(existing.listing_id))}`, {
      method: 'PATCH',
      body: updatePayload
    });
    if (!up.response.ok) throw new Error('listing update failed');
    return { success: true, listing_id: existing.listing_id, existing: true };
  }

  const insertPayload = {
    name: cleanText(activity.name, 240),
    category: cleanText(activity.category, 120) || null,
    description: cleanText(activity.desc, 2000) || null,
    address: cleanText(activity.addr, 240) || null,
    website: website || null,
    city: cityName,
    state: stateName,
    emoji: cleanText(activity.emoji, 20) || null,
    ages: Array.isArray(activity.ages) ? activity.ages.join(',') : cleanText(activity.ages, 240) || '',
    tags: Array.isArray(activity.tags) ? activity.tags.join(',') : cleanText(activity.tags, 240) || '',
    is_open: Object.prototype.hasOwnProperty.call(activity, 'open') ? !!activity.open : true,
    is_sponsored: false,
    rating: Number(activity.rating || 0) || null,
    review_count: 0,
    status: 'active',
    last_refreshed: now,
    source: source
  };
  const out = await sbRequest('listings', { method: 'POST', body: insertPayload });
  if (!out.response.ok) throw new Error('listing insert failed');
  const row = Array.isArray(out.data) ? out.data[0] : out.data;
  return { success: true, listing_id: row && row.listing_id ? row.listing_id : null, existing: false };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'Supabase service configuration missing' });

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  try {
    const action = cleanText(body.action, 80);
    if (action === 'track_analytics') return json(200, await insertAnalytics(body));
    if (action === 'touch_city_search') return json(200, await upsertCitySearch(body));
    if (action === 'capture_email_lead') return json(200, await captureEmailLead(body));
    if (action === 'submit_review') return json(200, await submitReview(body));
    if (action === 'replace_city_events') return json(200, await replaceCityEvents(body));
    if (action === 'upsert_listing') return json(200, await upsertListing(body));
    return json(400, { error: 'Unknown action' });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
