// KiddBusy - Daily Cache Warm
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPPORTED_CITIES = require('./_supported-cities.json');
const USE_WEB_SEARCH_CITIES = new Set(['Raleigh','Salt Lake City','Indianapolis','Kansas City','Buffalo','Jersey City','Louisville','Richmond','Boise','Tucson']);
const HIGH_PRIORITY_CITIES = new Set([
  'New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego','Dallas',
  'Austin','San Jose','Charlotte','San Francisco','Seattle','Denver','Boston','Atlanta','Miami','Orlando','Nashville'
]);
const ACTIVITIES_SYSTEM = 'You are KiddBusy. Return ONLY a JSON array of 20 kid-friendly activities. Each object: name(string), category(string), emoji(string), desc(string), addr(string), website(string official URL or null; avoid aggregators/search pages), open(boolean), ages(array of strings), tags(array of strings), rating(number 4-5), reviewCount(number).';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOT_CITY_REFRESH_HOURS = Math.max(Number(process.env.WARM_HOT_CITY_REFRESH_HOURS) || 12, 3);
const STANDARD_CITY_REFRESH_HOURS = Math.max(Number(process.env.WARM_STANDARD_CITY_REFRESH_HOURS) || 48, 6);
const MIN_LISTINGS_PER_CITY = Math.max(Number(process.env.WARM_MIN_LISTINGS_PER_CITY) || 12, 5);
const MAX_CITIES_PER_RUN = Math.max(Number(process.env.WARM_MAX_CITIES_PER_RUN) || 8, 1);

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

function buildCityStats(rows) {
  const stats = {};
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] || {};
    const city = normalizeCity(row.city);
    if (!city) continue;
    if (!stats[city]) stats[city] = { count: 0, latest_refreshed: '' };
    stats[city].count += 1;
    const refreshed = String(row.last_refreshed || '').trim();
    if (refreshed && (!stats[city].latest_refreshed || refreshed > stats[city].latest_refreshed)) {
      stats[city].latest_refreshed = refreshed;
    }
  }
  return stats;
}

function cityRefreshHours(city) {
  return HIGH_PRIORITY_CITIES.has(city) ? HOT_CITY_REFRESH_HOURS : STANDARD_CITY_REFRESH_HOURS;
}

function shouldWarmCity(city, statsByCity) {
  const stats = statsByCity[city] || { count: 0, latest_refreshed: '' };
  if (stats.count < MIN_LISTINGS_PER_CITY) {
    return { due: true, reason: 'low_inventory', count: stats.count, latest_refreshed: stats.latest_refreshed || null };
  }
  const refreshHours = cityRefreshHours(city);
  const latest = stats.latest_refreshed;
  if (!latest) {
    return { due: true, reason: 'missing_refresh_timestamp', count: stats.count, latest_refreshed: null };
  }
  const latestMs = new Date(latest).getTime();
  if (!Number.isFinite(latestMs)) {
    return { due: true, reason: 'invalid_refresh_timestamp', count: stats.count, latest_refreshed: latest };
  }
  const ageHours = (Date.now() - latestMs) / 3600000;
  if (ageHours >= refreshHours) {
    return { due: true, reason: 'stale_cache', count: stats.count, latest_refreshed: latest, age_hours: Number(ageHours.toFixed(1)) };
  }
  return { due: false, reason: 'fresh_enough', count: stats.count, latest_refreshed: latest, age_hours: Number(ageHours.toFixed(1)) };
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

function normalizeText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAddress(v) {
  return normalizeText(v)
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bparkway\b/g, 'pkwy');
}

function canonicalName(v) {
  return normalizeText(v)
    .replace(/\b(the|inc|llc|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWebsiteUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return 'https://' + v;
  return '';
}

function isNearDuplicate(activity, row) {
  var aCanon = canonicalName(activity && activity.name);
  var bCanon = canonicalName(row && row.name);
  if (!aCanon || !bCanon) return false;
  if (aCanon === bCanon) return true;
  if (aCanon.indexOf(bCanon) >= 0 || bCanon.indexOf(aCanon) >= 0) return true;
  var aAddr = normalizeAddress(activity && activity.addr);
  var bAddr = normalizeAddress(row && row.address);
  if (aAddr && bAddr && (aAddr === bAddr || aAddr.indexOf(bAddr) >= 0 || bAddr.indexOf(aAddr) >= 0)) {
    var aTokens = aCanon.split(' ').filter(Boolean);
    var bTokens = bCanon.split(' ').filter(Boolean);
    var set = {};
    var inter = 0;
    for (var i = 0; i < aTokens.length; i += 1) set[aTokens[i]] = 1;
    for (var j = 0; j < bTokens.length; j += 1) {
      if (set[bTokens[j]]) inter += 1;
      set[bTokens[j]] = 1;
    }
    var union = Object.keys(set).length || 1;
    return (inter / union) >= 0.6;
  }
  return false;
}

async function upsertListings(sb, activities, city) {
  const now = new Date().toISOString(); let saved = 0;
  const { data: cityRows } = await sb
    .from('listings')
    .select('listing_id,name,address,city,status,last_refreshed')
    .ilike('city', city)
    .eq('status', 'active')
    .limit(500);
  const cacheRows = Array.isArray(cityRows) ? cityRows.slice() : [];
  for (const a of activities) {
    const ages = Array.isArray(a.ages) ? a.ages.join(',') : (a.ages || '');
    const tags = Array.isArray(a.tags) ? a.tags.join(',') : (a.tags || '');
    const existing = cacheRows.find(function(r) { return isNearDuplicate(a, r); }) || null;
    const website = normalizeWebsiteUrl(a && a.website);
    if (existing) {
      const updatePayload = {
        name: a.name,
        category: a.category,
        description: a.desc,
        address: a.addr,
        is_open: a.open ?? true,
        last_refreshed: now,
        source: 'background_refresh'
      };
      if (website) updatePayload.website = website;
      await sb.from('listings').update(updatePayload).eq('listing_id', existing.listing_id);
    } else {
      const out = await sb.from('listings').insert({ name: a.name, category: a.category, description: a.desc, address: a.addr, website: website || null, city, state: '', emoji: a.emoji, ages, tags, is_open: a.open ?? true, is_sponsored: false, rating: a.rating || 4.5, review_count: 0, status: 'active', last_refreshed: now, source: 'background_refresh' }).select('listing_id').single();
      if (out && out.data && out.data.listing_id) {
        cacheRows.push({
          listing_id: out.data.listing_id,
          name: a.name,
          address: a.addr,
          city: city,
          status: 'active',
          last_refreshed: now
        });
      }
    }
    saved++;
  }
  return saved;
}
exports.handler = async function(event) {
  console.log('[WARM] Starting');
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'missing_supabase_config' })
    };
  }
  if (!ANTHROPIC_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'missing_anthropic_key' })
    };
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const allCities = getSupportedCities();
  const { data: listingRows } = await sb
    .from('listings')
    .select('city,last_refreshed,status')
    .eq('status', 'active')
    .limit(10000);
  const statsByCity = buildCityStats(Array.isArray(listingRows) ? listingRows : []);
  // 12 buckets on an hourly schedule -> each city is evaluated about every 12 hours.
  const totalBuckets = 12;
  const currentBucket = new Date().getUTCHours();
  const forceFull = !!(event && event.queryStringParameters && String(event.queryStringParameters.full || '') === '1');
  const singleCity = normalizeCity(event && event.queryStringParameters && event.queryStringParameters.city);
  let candidateCities = forceFull
    ? allCities
    : allCities.filter(function(city) { return hashCityToBucket(city, totalBuckets) === (currentBucket % totalBuckets); });
  if (singleCity) {
    candidateCities = allCities.filter(function(city) {
      return String(city).toLowerCase() === String(singleCity).toLowerCase();
    });
  }
  const dueMeta = {};
  let runCities = candidateCities.filter(function(city) {
    const meta = forceFull || singleCity ? { due: true, reason: forceFull ? 'forced_full_run' : 'single_city' } : shouldWarmCity(city, statsByCity);
    dueMeta[city] = meta;
    return !!meta.due;
  });
  runCities.sort(function(a, b) {
    const aMeta = dueMeta[a] || {};
    const bMeta = dueMeta[b] || {};
    const aPriority = HIGH_PRIORITY_CITIES.has(a) ? 1 : 0;
    const bPriority = HIGH_PRIORITY_CITIES.has(b) ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    const aCount = Number(aMeta.count || 0);
    const bCount = Number(bMeta.count || 0);
    if (aCount !== bCount) return aCount - bCount;
    return String(a).localeCompare(String(b));
  });
  if (!forceFull && !singleCity && runCities.length > MAX_CITIES_PER_RUN) {
    runCities = runCities.slice(0, MAX_CITIES_PER_RUN);
  }

  console.log('[WARM] supported cities=' + allCities.length + ', eval bucket=' + currentBucket + '/' + totalBuckets + ', candidates=' + candidateCities.length + ', due=' + runCities.length + ', forceFull=' + forceFull + ', city=' + (singleCity || 'none'));
  const results = {}; let succeeded = 0, failed = 0;
  for (let i = 0; i < runCities.length; i++) {
    const city = runCities[i];
    const useWebSearch = USE_WEB_SEARCH_CITIES.has(city);
    try {
      console.log('[WARM] (' + (i+1) + '/' + runCities.length + ') ' + city);
      const activities = await callAI(city, useWebSearch);
      const saved = await upsertListings(sb, activities, city);
      results[city] = { status: 'ok', saved: saved, reason: dueMeta[city] ? dueMeta[city].reason : 'unknown' }; succeeded++;
    } catch (err) {
      console.error('[WARM] FAIL ' + city + ': ' + err.message);
      results[city] = { status: 'fail', error: err.message, reason: dueMeta[city] ? dueMeta[city].reason : 'unknown' }; failed++;
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
      candidate_cities: candidateCities.length,
      run_cities: runCities.length,
      force_full: forceFull,
      city: singleCity || null,
      refresh_policy: {
        hot_city_refresh_hours: HOT_CITY_REFRESH_HOURS,
        standard_city_refresh_hours: STANDARD_CITY_REFRESH_HOURS,
        min_listings_per_city: MIN_LISTINGS_PER_CITY,
        max_cities_per_run: MAX_CITIES_PER_RUN
      },
      succeeded,
      failed,
      results
    })
  };
};
