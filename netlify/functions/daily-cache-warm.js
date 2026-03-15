// KiddBusy - Daily Cache Warm
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.KB_DB_URL;
const SUPABASE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPPORTED_CITIES = require('./_supported-cities.json');
const USE_WEB_SEARCH_CITIES = new Set(['Raleigh','Salt Lake City','Indianapolis','Kansas City','Buffalo','Jersey City','Louisville','Richmond','Boise','Tucson']);
const ACTIVITIES_SYSTEM = 'You are KiddBusy. Return ONLY a JSON array of 20 kid-friendly activities. Each object: name(string), category(string), emoji(string), desc(string), addr(string), open(boolean), ages(array of strings), tags(array of strings), rating(number 4-5), reviewCount(number).';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeCity(v) {
  return String(v || '').trim();
}

function hashCityToBucket(city, buckets) {
  var s = String(city || '').toLowerCase();
  var h = 0;
  for (var i = 0; i < s.length; i += 1) {
    h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  }
  return buckets > 0 ? (h % buckets) : 0;
}

function getSupportedCities() {
  if (!Array.isArray(SUPPORTED_CITIES)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < SUPPORTED_CITIES.length; i += 1) {
    var city = normalizeCity(SUPPORTED_CITIES[i]);
    if (!city) continue;
    var key = city.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(city);
  }
  return out;
}
async function callAI(city, useWebSearch) {
  const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 3200, system: ACTIVITIES_SYSTEM, messages: [{ role: 'user', content: 'List 20 kid-friendly activities in "' + city + '". Return only JSON array.' }] };
  if (useWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (res.status === 429 || res.status === 529) { if (attempt < 3) { await sleep(attempt * 15000); continue; } throw new Error('Rate limited'); }
    if (data.error) throw new Error(data.error.message);
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    const raw = textBlocks[textBlocks.length - 1]?.text || '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON');
    return JSON.parse(match[0]);
  }
}
async function upsertListings(sb, activities, city) {
  const now = new Date().toISOString(); let saved = 0;
  for (const a of activities) {
    const ages = Array.isArray(a.ages) ? a.ages.join(',') : (a.ages || '');
    const tags = Array.isArray(a.tags) ? a.tags.join(',') : (a.tags || '');
    const { data: existing } = await sb.from('listings').select('listing_id').ilike('name', a.name).ilike('city', city).maybeSingle();
    if (existing) {
      await sb.from('listings').update({ description: a.desc, is_open: a.open ?? true, last_refreshed: now, source: 'background_refresh' }).eq('listing_id', existing.listing_id);
    } else {
      await sb.from('listings').insert({ name: a.name, category: a.category, description: a.desc, address: a.addr, city, state: '', emoji: a.emoji, ages, tags, is_open: a.open ?? true, is_sponsored: false, rating: a.rating || 4.5, review_count: 0, status: 'active', last_refreshed: now, source: 'background_refresh' });
    }
    saved++;
  }
  return saved;
}
exports.handler = async function(event) {
  console.log('[WARM] Starting');
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const allCities = getSupportedCities();
  const totalBuckets = 24;
  const currentBucket = new Date().getUTCHours();
  const forceFull = !!(event && event.queryStringParameters && String(event.queryStringParameters.full || '') === '1');
  const runCities = forceFull
    ? allCities
    : allCities.filter(function(city) { return hashCityToBucket(city, totalBuckets) === currentBucket; });

  console.log('[WARM] supported cities=' + allCities.length + ', run bucket=' + currentBucket + '/' + totalBuckets + ', this run=' + runCities.length + ', forceFull=' + forceFull);
  const results = {}; let succeeded = 0, failed = 0;
  for (let i = 0; i < runCities.length; i++) {
    const city = runCities[i];
    const useWebSearch = USE_WEB_SEARCH_CITIES.has(city);
    try {
      console.log('[WARM] (' + (i+1) + '/' + runCities.length + ') ' + city);
      const activities = await callAI(city, useWebSearch);
      const saved = await upsertListings(sb, activities, city);
      results[city] = 'ok:' + saved; succeeded++;
    } catch (err) {
      console.error('[WARM] FAIL ' + city + ': ' + err.message);
      results[city] = 'fail:' + err.message; failed++;
    }
    if (i < runCities.length - 1) await sleep(2500);
  }
  console.log('[WARM] Done bucket ' + currentBucket + ': ' + succeeded + ' ok, ' + failed + ' failed');
  return {
    statusCode: 200,
    body: JSON.stringify({
      supported_cities: allCities.length,
      bucket: currentBucket,
      buckets_total: totalBuckets,
      run_cities: runCities.length,
      force_full: forceFull,
      succeeded,
      failed,
      results
    })
  };
};
