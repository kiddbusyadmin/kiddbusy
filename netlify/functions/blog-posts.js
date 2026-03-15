const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CITY_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const EVENTS_MIN_RENDER_COUNT = 2;
const searchFunction = require('./search');

const TOP_25_CITIES_BY_POPULATION = [
  'New York',
  'Los Angeles',
  'Chicago',
  'Houston',
  'Phoenix',
  'Philadelphia',
  'San Antonio',
  'San Diego',
  'Dallas',
  'Jacksonville',
  'Austin',
  'Fort Worth',
  'San Jose',
  'Columbus',
  'Charlotte',
  'Indianapolis',
  'San Francisco',
  'Seattle',
  'Denver',
  'Washington',
  'Boston',
  'El Paso',
  'Nashville',
  'Detroit',
  'Oklahoma City'
];

let cityStateCache = { at: 0, map: {} };

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payload)
  };
}

async function sbRequest(path, method, body, prefer) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: method || 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    },
    body: body == null ? undefined : JSON.stringify(body)
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

async function sbGet(path) {
  return sbRequest(path, 'GET', null, 'return=representation');
}

function normalizeState(value) {
  const v = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : '';
}

function normalizeCityBase(value) {
  return String(value || '').split(',')[0].trim();
}

function cityKey(value) {
  return normalizeCityBase(value).toLowerCase();
}

function slugifyCity(value) {
  return normalizeCityBase(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function withCityState(cityRaw, cityStateMap) {
  const raw = String(cityRaw || '').trim();
  if (!raw) return '';
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const city = parts[0] || '';
  const explicitState = normalizeState(parts[1] || '');
  if (city && explicitState) return `${city}, ${explicitState}`;
  const inferred = cityStateMap[String(city || '').toLowerCase()] || '';
  return inferred ? `${city}, ${inferred}` : city;
}

async function loadCityStateMap() {
  const now = Date.now();
  if (cityStateCache.at && (now - cityStateCache.at) < CITY_STATE_TTL_MS) {
    return cityStateCache.map || {};
  }

  const out = await sbGet('listings?select=city,state&status=eq.active&limit=8000');
  const map = {};
  if (out.response.ok && Array.isArray(out.data)) {
    for (let i = 0; i < out.data.length; i += 1) {
      const row = out.data[i] || {};
      const city = normalizeCityBase(row.city);
      const state = normalizeState(row.state);
      if (!city || !state) continue;
      const key = city.toLowerCase();
      if (!map[key]) map[key] = state;
    }
  }
  cityStateCache = { at: now, map };
  return map;
}

function addCityDisplay(post, cityStateMap) {
  const row = post || {};
  const base = normalizeCityBase(row.city);
  return Object.assign({}, row, {
    city_display: withCityState(row.city, cityStateMap),
    city_slug: slugifyCity(base),
    city_hub_url: base ? `/blog/city/${encodeURIComponent(slugifyCity(base))}` : null
  });
}

function toIsoDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function isPastEventRow(row, todayIso) {
  const start = toIsoDate(row.start_date);
  const end = toIsoDate(row.end_date);
  const ongoing = !!row.ongoing;
  if (ongoing && end) return end < todayIso;
  if (end) return end < todayIso;
  if (start) return start < todayIso;
  return false;
}

function sortListings(rows) {
  const out = rows.slice();
  out.sort((a, b) => {
    const as = a && a.is_sponsored ? 1 : 0;
    const bs = b && b.is_sponsored ? 1 : 0;
    if (bs !== as) return bs - as;
    const ar = Number(a && a.rating) || 0;
    const br = Number(b && b.rating) || 0;
    if (br !== ar) return br - ar;
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
  });
  return out;
}

function sortEvents(rows) {
  const out = rows.slice();
  out.sort((a, b) => {
    const ad = toIsoDate(a && a.start_date);
    const bd = toIsoDate(b && b.start_date);
    if (ad && bd && ad !== bd) return ad.localeCompare(bd);
    const ar = String((a && a.last_refreshed) || '');
    const br = String((b && b.last_refreshed) || '');
    if (ar !== br) return br.localeCompare(ar);
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
  });
  return out;
}

function sortPosts(rows) {
  const out = rows.slice();
  out.sort((a, b) => String((b && b.published_at) || '').localeCompare(String((a && a.published_at) || '')));
  return out;
}

function normalizeHubEventRows(items, cityName) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const nowIso = new Date().toISOString();
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i] || {};
    const name = String(row.name || '').trim().slice(0, 180);
    const sourceUrl = String(row.source_url || '').trim().slice(0, 500);
    const month = String(row.month || '').trim().slice(0, 6).toUpperCase();
    const day = String(row.day || '').trim().slice(0, 4);
    const detail = String(row.detail || '').trim().slice(0, 420);
    if (!name || !sourceUrl || !month || !day || !detail) continue;
    out.push({
      city: cityName,
      month: month,
      day: day,
      name: name,
      detail: detail,
      is_free: !!row.free,
      source_url: sourceUrl,
      start_date: toIsoDate(row.start_date) || null,
      end_date: toIsoDate(row.end_date) || null,
      ongoing: !!row.ongoing,
      last_refreshed: nowIso
    });
  }
  return out.slice(0, 8);
}

function parseSearchPayload(functionResult) {
  if (!functionResult || !functionResult.body) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(functionResult.body);
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.content) || !parsed.content.length) return [];
  const first = parsed.content[0] || {};
  const text = String(first.text || '').trim();
  if (!text) return [];
  let arr = null;
  try {
    arr = JSON.parse(text);
  } catch {
    arr = null;
  }
  return Array.isArray(arr) ? arr : [];
}

async function warmCityEvents(cityName) {
  const event = {
    httpMethod: 'POST',
    body: JSON.stringify({ city: cityName, type: 'events' })
  };
  const response = await searchFunction.handler(event, {});
  if (!response || Number(response.statusCode) !== 200) {
    return { ok: false, inserted: 0, reason: 'search_unavailable' };
  }
  const items = parseSearchPayload(response);
  const rows = normalizeHubEventRows(items, cityName);
  if (rows.length < EVENTS_MIN_RENDER_COUNT) {
    return { ok: false, inserted: 0, reason: 'insufficient_events' };
  }

  const cityPrefix = `${cityName}%`;
  await sbRequest(`events?city=ilike.${encodeURIComponent(cityPrefix)}`, 'DELETE', null, 'return=minimal');
  const insert = await sbRequest('events', 'POST', rows, 'return=representation');
  if (!insert.response.ok || !Array.isArray(insert.data)) {
    return { ok: false, inserted: 0, reason: 'db_insert_failed' };
  }
  return { ok: true, inserted: insert.data.length };
}

async function loadHubDatasets() {
  const [listings, events, posts] = await Promise.all([
    sbGet('listings?select=listing_id,name,city,category,address,website,rating,is_sponsored,status&status=eq.active&limit=10000'),
    sbGet('events?select=id,city,month,day,name,detail,is_free,source_url,start_date,end_date,ongoing,last_refreshed&limit=10000'),
    sbGet('blog_posts?select=id,slug,title,excerpt,city,published_at,tags&status=eq.published&order=published_at.desc&limit=5000')
  ]);

  return {
    listings: (listings.response.ok && Array.isArray(listings.data)) ? listings.data : [],
    events: (events.response.ok && Array.isArray(events.data)) ? events.data : [],
    posts: (posts.response.ok && Array.isArray(posts.data)) ? posts.data : []
  };
}

function buildCityHub(cityName, datasets, cityStateMap, opts) {
  const options = opts || {};
  const base = normalizeCityBase(cityName);
  const key = cityKey(base);
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentSlug = String(options.currentSlug || '').trim().toLowerCase();

  const listings = sortListings((datasets.listings || []).filter((r) => cityKey(r && r.city) === key));
  const events = sortEvents((datasets.events || []).filter((r) => cityKey(r && r.city) === key && !!String((r && r.source_url) || '').trim() && !isPastEventRow(r || {}, todayIso)));
  const posts = sortPosts((datasets.posts || []).filter((r) => cityKey(r && r.city) === key && String((r && r.slug) || '').toLowerCase() !== currentSlug));

  const relatedOtherCities = [];
  for (let i = 0; i < TOP_25_CITIES_BY_POPULATION.length; i += 1) {
    const c = TOP_25_CITIES_BY_POPULATION[i];
    const cKey = cityKey(c);
    if (!cKey || cKey === key) continue;
    const count = (datasets.posts || []).filter((r) => cityKey(r && r.city) === cKey).length;
    relatedOtherCities.push({ city: c, post_count: count, city_slug: slugifyCity(c), city_display: withCityState(c, cityStateMap) });
  }
  relatedOtherCities.sort((a, b) => b.post_count - a.post_count);

  return {
    city: base,
    city_display: withCityState(base, cityStateMap),
    city_slug: slugifyCity(base),
    refreshed_date: todayIso,
    summary: {
      listings_count: listings.length,
      events_count: events.length,
      posts_count: posts.length
    },
    top_listings: listings.slice(0, 8).map((r) => ({
      listing_id: r.listing_id,
      name: r.name,
      category: r.category,
      address: r.address,
      website: r.website,
      rating: r.rating,
      is_sponsored: !!r.is_sponsored
    })),
    latest_events: events.slice(0, 8).map((r) => ({
      event_id: r.id,
      month: r.month,
      day: r.day,
      name: r.name,
      detail: r.detail,
      is_free: !!r.is_free,
      source_url: r.source_url,
      start_date: r.start_date,
      end_date: r.end_date,
      ongoing: !!r.ongoing
    })),
    related_posts: posts.slice(0, 8).map((p) => ({
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt,
      city: p.city,
      city_display: withCityState(p.city, cityStateMap),
      city_slug: slugifyCity(p.city),
      city_hub_url: '/blog/city/' + encodeURIComponent(slugifyCity(p.city)),
      published_at: p.published_at
    })),
    related_city_hubs: relatedOtherCities.slice(0, 8).map((c) => ({
      city: c.city,
      city_display: c.city_display,
      city_slug: c.city_slug,
      url: '/blog/city/' + encodeURIComponent(c.city_slug)
    }))
  };
}

function resolveHubCity(value) {
  const raw = normalizeCityBase(value);
  const key = cityKey(raw);
  if (!raw) return '';
  for (let i = 0; i < TOP_25_CITIES_BY_POPULATION.length; i += 1) {
    const c = TOP_25_CITIES_BY_POPULATION[i];
    if (cityKey(c) === key || slugifyCity(c) === raw.toLowerCase()) return c;
  }
  return raw;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase configuration missing' });
  }

  const params = event.queryStringParameters || {};
  const slug = String(params.slug || '').trim();
  const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);
  const cityHub = String(params.city_hub || '').trim();
  const cityHubs = String(params.city_hubs || '').trim() === '1';
  const currentSlug = String(params.current_slug || '').trim();
  const cityStateMap = await loadCityStateMap();

  if (slug) {
    const query = `blog_posts?select=id,slug,title,excerpt,body_html,seo_description,tags,city,author,read_minutes,published_at&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`;
    const { response, data } = await sbGet(query);
    if (!response.ok) return json(response.status, { error: 'Failed to load post', details: data });
    const post = Array.isArray(data) && data.length ? data[0] : null;
    if (!post) return json(404, { error: 'Post not found' });
    return json(200, { success: true, post: addCityDisplay(post, cityStateMap) });
  }

  if (cityHub) {
    const city = resolveHubCity(cityHub);
    let datasets = await loadHubDatasets();
    let hub = buildCityHub(city, datasets, cityStateMap, { currentSlug: currentSlug });
    if ((hub.summary && Number(hub.summary.events_count || 0) < EVENTS_MIN_RENDER_COUNT)) {
      try {
        const warmed = await warmCityEvents(city);
        if (warmed.ok) {
          datasets = await loadHubDatasets();
          hub = buildCityHub(city, datasets, cityStateMap, { currentSlug: currentSlug });
          hub.cache_warmed = true;
          hub.cache_warm_inserted = warmed.inserted;
        }
      } catch (_) {}
    }
    return json(200, { success: true, hub: hub });
  }

  if (cityHubs) {
    const datasets = await loadHubDatasets();
    const hubs = TOP_25_CITIES_BY_POPULATION.map((city) => buildCityHub(city, datasets, cityStateMap, {})).map((hub) => ({
      city: hub.city,
      city_display: hub.city_display,
      city_slug: hub.city_slug,
      url: '/blog/city/' + encodeURIComponent(hub.city_slug),
      refreshed_date: hub.refreshed_date,
      summary: hub.summary,
      top_listings: hub.top_listings.slice(0, 3),
      latest_events: hub.latest_events.slice(0, 3),
      related_posts: hub.related_posts.slice(0, 3)
    }));
    return json(200, {
      success: true,
      refreshed_date: new Date().toISOString().slice(0, 10),
      count: hubs.length,
      hubs: hubs
    });
  }

  const query = `blog_posts?select=id,slug,title,excerpt,seo_description,tags,city,author,read_minutes,published_at&status=eq.published&order=published_at.desc&limit=${limit}`;
  const { response, data } = await sbGet(query);
  if (!response.ok) return json(response.status, { error: 'Failed to load posts', details: data });
  const posts = (Array.isArray(data) ? data : []).map((p) => addCityDisplay(p, cityStateMap));
  return json(200, { success: true, count: posts.length, posts: posts });
};
