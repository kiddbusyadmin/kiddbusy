const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CITY_STATE_TTL_MS = 6 * 60 * 60 * 1000;
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

async function sbGet(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
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

function normalizeState(value) {
  const v = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : '';
}

function normalizeCityBase(value) {
  return String(value || '').split(',')[0].trim();
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

function addCityDisplay(post, cityStateMap) {
  const row = post || {};
  return Object.assign({}, row, {
    city_display: withCityState(row.city, cityStateMap)
  });
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
  const cityStateMap = await loadCityStateMap();

  if (slug) {
    const query = `blog_posts?select=id,slug,title,excerpt,body_html,seo_description,tags,city,author,read_minutes,published_at&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`;
    const { response, data } = await sbGet(query);
    if (!response.ok) return json(response.status, { error: 'Failed to load post', details: data });
    const post = Array.isArray(data) && data.length ? data[0] : null;
    if (!post) return json(404, { error: 'Post not found' });
    return json(200, { success: true, post: addCityDisplay(post, cityStateMap) });
  }

  const query = `blog_posts?select=id,slug,title,excerpt,seo_description,tags,city,author,read_minutes,published_at&status=eq.published&order=published_at.desc&limit=${limit}`;
  const { response, data } = await sbGet(query);
  if (!response.ok) return json(response.status, { error: 'Failed to load posts', details: data });
  const posts = (Array.isArray(data) ? data : []).map((p) => addCityDisplay(p, cityStateMap));
  return json(200, { success: true, count: posts.length, posts: posts });
};
