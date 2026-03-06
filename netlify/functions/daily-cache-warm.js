// KiddBusy - Daily Cache Warm
// Runs once per day at 3am ET via Netlify scheduled function.
// Refreshes listings for all top cities WITHOUT web search (cost optimized).
// Web search is only enabled for smaller/less-known cities.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.KB_DB_URL;
const SUPABASE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const TOP_CITIES = [
  'Houston', 'Austin', 'Los Angeles', 'New York City', 'Chicago',
  'Denver', 'Columbus', 'Tampa', 'Orlando', 'Miami',
  'Atlanta', 'Nashville', 'Boston', 'Philadelphia', 'Seattle',
  'Phoenix', 'Las Vegas', 'San Diego', 'San Francisco', 'Charlotte',
  'Minneapolis', 'Portland', 'New Orleans', 'Honolulu', 'Memphis'
];

const USE_WEB_SEARCH_CITIES = new Set([
  'Raleigh', 'Salt Lake City', 'Indianapolis', 'Kansas City',
  'Buffalo', 'Jersey City', 'Louisville', 'Richmond', 'Boise', 'Tucson'
]);

const ACTIVITIES_SYSTEM = 'You are KiddBusy, a family activity finder. When given a city, return ONLY a JSON array of exactly 20 kid-friendly activity objects. No markdown, no explanation, just raw JSON. Each object must have: name, category, emoji, desc, addr, open, ages, tags, rating, reviewCount.';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAI(city, useWebSearch) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3200,
    system: ACTIVITIES_SYSTEM,
    messages: [{
      role: 'user',
      content: useWebSearch
        ? 'Find 20 kid-friendly activities in "' + city + '". Search web for accuracy. Return only JSON array.'
        : 'List 20 kid-friendly activities in "' + city + '". Return only JSON array.'
    }]
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (res.status === 429 || res.status === 529) {
      if (attempt < MAX_RETRIES) {
        await sleep(attempt * 15000);
        continue;
      }
      throw new Error('Rate limited after ' + MAX_RETRIES + ' attempts');
    }

    if (data.error) throw new Error(data.error.message);

    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const raw = textBlocks[textBlocks.length - 1]?.text || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');
    return JSON.parse(match[0]);
  }
}

async function upsertListings(sb, activities, city) {
  const now = new Date().toISOString();
  let saved = 0;

  for (const a of activities) {
    const { data: existing } = await sb
      .from('listings')
      .select('listing_id')
      .ilike('name', a.name)
      .ilike('city', city)
      .maybeSingle();

    if (existing) {
      await sb.from('listings').update({
        description: a.desc,
        is_open: a.open ?? true,
        last_refreshed: now,
        source: 'background_refresh',
      }).eq('listing_id', existing.listing_id);
    } else {
      await sb.from('listings').insert({
        name: a.name,
        category: a.category,
        description: a.desc,
        address: a.addr,
        city: city,
        state: '',
        emoji: a.emoji,
        ages: a.ages?.join(',') || '',
        tags: a.tags?.join(',') || '',
        is_open: a.open ?? true,
        is_sponsored: false,
        rating: a.rating || 4.5,
        review_count: 0,
        status: 'active',
        last_refreshed: now,
        source: 'background_refresh',
      });
    }
    saved++;
  }
  return saved;
}

exports.handler = async function(event) {
  const isManual = event?.httpMethod === 'GET';
  console.log('[WARM] Starting - ' + (isManual ? 'MANUAL' : 'SCHEDULED'));

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const topSet = new Set(TOP_CITIES);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentSearches } = await sb
    .from('city_searches')
    .select('city')
    .gte('last_searched', thirtyDaysAgo)
    .order('last_searched', { ascending: false });

  const extraCities = (recentSearches || []).map(r => r.city).filter(c => !topSet.has(c));
  const allCities = [...TOP_CITIES, ...extraCities];
  console.log('[WARM] ' + allCities.length + ' cities to warm');

  const results = {};
  let succeeded = 0, failed = 0;

  for (let i = 0; i < allCities.length; i++) {
    const city = allCities[i];
    const useWebSearch = USE_WEB_SEARCH_CITIES.has(city) || !topSet.has(city);

    try {
      console.log('[WARM] (' + (i+1) + '/' + allCities.length + ') ' + city);
      const activities = await callAI(city, useWebSearch);
      const saved = await upsertListings(sb, activities, city);
      results[city] = 'ok: ' + saved;
      succeeded++;
    } catch (err) {
      console.error('[WARM] FAIL ' + city + ': ' + err.message);
      results[city] = 'fail: ' + err.message;
      failed++;
    }

    if (i < allCities.length - 1) await sleep(8000);
  }

  console.log('[WARM] Done: ' + succeeded + ' ok, ' + failed + ' failed');
  return { statusCode: 200, body: JSON.stringify({ succeeded, failed, results }) };
};
