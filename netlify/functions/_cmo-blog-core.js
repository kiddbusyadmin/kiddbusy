const { logAgentActivity } = require('./_agent-activity');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CMO_RUN_TOKEN = process.env.CMO_RUN_TOKEN || process.env.ADMIN_PASSWORD || '';
const CMO_BLOG_MODELS = String(process.env.CMO_BLOG_MODELS || '').trim();

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function clampNumber(value, min, max, fallback) {
  var n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.floor(n);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function startOfUtcDayIso() {
  var d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)).toISOString();
}

function getPreferredModels() {
  if (CMO_BLOG_MODELS) {
    return CMO_BLOG_MODELS
      .split(',')
      .map(function (m) { return String(m || '').trim(); })
      .filter(Boolean);
  }
  // Default to highest quality writing model first, then reliable fallback.
  return ['claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514'];
}

async function sbFetch(path, options) {
  var opts = options || {};
  var method = opts.method || 'GET';
  var body = Object.prototype.hasOwnProperty.call(opts, 'body') ? opts.body : null;
  var prefer = opts.prefer || null;

  var headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;

  var response = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : null
  });

  var text = await response.text();
  var data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  return { response: response, data: data };
}

async function getSettings() {
  var defaults = {
    blog_queue_target_per_day: 50,
    blog_distribution_enabled: true,
    blog_publish_rate_per_day: 1
  };
  var q = 'cmo_agent_settings?id=eq.1&select=blog_queue_target_per_day,blog_distribution_enabled,blog_publish_rate_per_day';
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data) || !result.data[0]) return defaults;

  var row = result.data[0];
  return {
    blog_queue_target_per_day: clampNumber(row.blog_queue_target_per_day, 1, 200, 50),
    blog_distribution_enabled: row.blog_distribution_enabled !== false,
    blog_publish_rate_per_day: clampNumber(row.blog_publish_rate_per_day, 1, 20, 1)
  };
}

async function getCities() {
  var result = await sbFetch('listings?select=city&status=eq.active&order=city.asc&limit=2000');
  if (!result.response.ok || !Array.isArray(result.data)) return ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Phoenix'];

  var seen = {};
  var cities = [];
  for (var i = 0; i < result.data.length; i += 1) {
    var city = String((result.data[i] && result.data[i].city) || '').trim();
    if (!city) continue;
    if (seen[city]) continue;
    seen[city] = true;
    cities.push(city);
    if (cities.length >= 40) break;
  }
  return cities.length ? cities : ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Phoenix'];
}

async function getCityListingContext(city, limit) {
  var safeCity = encodeURIComponent(String(city || '').trim());
  if (!safeCity) return [];
  var maxRows = clampNumber(limit, 3, 20, 10);
  var fetchRows = clampNumber(maxRows * 8, 10, 120, 40);
  var q = 'listings?select=name,category,address,website,is_sponsored&city=ilike.*' + safeCity + '*&status=eq.active&order=rating.desc.nullslast&limit=' + String(fetchRows);
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data)) return [];
  var filtered = [];
  for (var i = 0; i < result.data.length; i += 1) {
    if (isLikelyFreePublicListing(result.data[i])) filtered.push(result.data[i]);
    if (filtered.length >= maxRows) break;
  }
  return filtered;
}

function pickTargetCity(cities, preferredCity) {
  if (preferredCity) {
    var wanted = String(preferredCity).trim().toLowerCase();
    for (var i = 0; i < cities.length; i += 1) {
      if (String(cities[i]).trim().toLowerCase() === wanted) return cities[i];
    }
  }
  if (!cities.length) return 'Houston';
  return cities[Math.floor(Math.random() * cities.length)];
}

function buildCityContextBlock(city, rows) {
  if (!rows || !rows.length) return 'No local listing context available in DB for this city.';
  var lines = [];
  lines.push('Known local listings for ' + city + ' (use only if relevant and accurate):');
  for (var i = 0; i < rows.length; i += 1) {
    var r = rows[i] || {};
    lines.push(
      '- ' +
      String(r.name || 'Unknown Place') +
      ' | ' +
      String(r.category || 'activity') +
      ' | ' +
      String(r.address || 'no address') +
      ' | website: ' +
      String(r.website || 'none')
    );
  }
  return lines.join('\n');
}

function countNameMentions(text, names) {
  var hay = String(text || '').toLowerCase();
  if (!hay) return 0;
  var hits = 0;
  for (var i = 0; i < names.length; i += 1) {
    var n = String(names[i] || '').trim().toLowerCase();
    if (!n || n.length < 4) continue;
    if (hay.indexOf(n) >= 0) hits += 1;
  }
  return hits;
}

function safeLower(v) {
  return String(v || '').trim().toLowerCase();
}

function isPublicDomain(website) {
  var url = safeLower(website);
  if (!url) return false;
  return (
    url.indexOf('.gov') >= 0 ||
    url.indexOf('.edu') >= 0 ||
    url.indexOf('publiclibrary') >= 0 ||
    url.indexOf('parks') >= 0 ||
    url.indexOf('recreation') >= 0 ||
    url.indexOf('cityof') >= 0 ||
    url.indexOf('county') >= 0
  );
}

function isLikelyFreePublicListing(row) {
  var r = row || {};
  if (r.is_sponsored === true) return false;
  var hay = safeLower([r.name, r.category, r.address, r.website].join(' '));
  if (!hay) return false;

  var blocked = [
    'museum',
    'zoo',
    'aquarium',
    'theater',
    'cinema',
    'trampoline',
    'arcade',
    'play cafe',
    'gymnastics',
    'music school',
    'dance studio',
    'class',
    'camp',
    'restaurant',
    'cafe',
    'brewery',
    'ticket',
    'admission',
    'membership'
  ];
  for (var i = 0; i < blocked.length; i += 1) {
    if (hay.indexOf(blocked[i]) >= 0) return false;
  }

  var freePublicSignals = [
    'park',
    'playground',
    'library',
    'trail',
    'greenway',
    'nature center',
    'community center',
    'splash pad',
    'beach',
    'riverwalk',
    'public pool',
    'plaza'
  ];
  for (var j = 0; j < freePublicSignals.length; j += 1) {
    if (hay.indexOf(freePublicSignals[j]) >= 0) return true;
  }
  return isPublicDomain(r.website);
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  var clean = String(text || '').trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

function hasCurrentTimeAnchor(text) {
  var hay = String(text || '').toLowerCase();
  if (!hay) return false;
  var anchors = [
    'this weekend',
    'this month',
    'this week',
    'today',
    'tomorrow',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'january',
    'february'
  ];
  for (var i = 0; i < anchors.length; i += 1) {
    if (hay.indexOf(anchors[i]) >= 0) return true;
  }
  if (/\b\d{1,2}\/\d{1,2}\b/.test(hay)) return true;
  if (/\b\d{1,2}-\d{1,2}\b/.test(hay)) return true;
  return false;
}

function hasCommercialSignals(text) {
  var hay = safeLower(text);
  if (!hay) return false;
  var blocked = [
    'museum',
    'zoo',
    'aquarium',
    'ticket',
    'tickets',
    'admission',
    'membership',
    'book now',
    'reserve now',
    'buy now',
    'price:'
  ];
  for (var i = 0; i < blocked.length; i += 1) {
    if (hay.indexOf(blocked[i]) >= 0) return true;
  }
  return false;
}

function hasStrongLocalSignals(post, targetCity, localListingNames) {
  var city = String(targetCity || '').trim().toLowerCase();
  var body = String((post && post.body_html) || '').toLowerCase();
  var title = String((post && post.title) || '').toLowerCase();
  var excerpt = String((post && post.excerpt) || '').toLowerCase();
  var combined = title + ' ' + excerpt + ' ' + body;

  if (!city || combined.indexOf(city) < 0) return false;
  if (wordCount(stripTags(body)) < 220) return false;
  if (!hasCurrentTimeAnchor(combined)) return false;
  if (hasCommercialSignals(combined)) return false;

  var mentions = countNameMentions(combined, localListingNames || []);
  if (localListingNames && localListingNames.length) {
    var minimumMentions = localListingNames.length >= 5 ? 3 : 2;
    if (mentions < minimumMentions) return false;
    return true;
  }

  // Fallback heuristic when no local listing names are available.
  var anchors = ['park', 'library', 'trail', 'playground', 'greenway', 'neighborhood', 'public'];
  var anchorHits = 0;
  for (var i = 0; i < anchors.length; i += 1) {
    if (combined.indexOf(anchors[i]) >= 0) anchorHits += 1;
  }
  return anchorHits >= 3;
}

async function getIdentitySets() {
  var result = await sbFetch('blog_posts?select=title,slug&order=created_at.desc&limit=5000');
  var titles = new Set();
  var slugs = new Set();

  if (result.response.ok && Array.isArray(result.data)) {
    for (var i = 0; i < result.data.length; i += 1) {
      var row = result.data[i] || {};
      var t = String(row.title || '').trim().toLowerCase();
      var s = String(row.slug || '').trim().toLowerCase();
      if (t) titles.add(t);
      if (s) slugs.add(s);
    }
  }
  return { titles: titles, slugs: slugs };
}

function parseAnthropicArray(rawText) {
  var body = JSON.parse(rawText);
  var txt = '';
  if (Array.isArray(body.content)) {
    for (var i = 0; i < body.content.length; i += 1) {
      var chunk = body.content[i];
      if (chunk && chunk.type === 'text' && chunk.text) txt += String(chunk.text) + '\n';
    }
  }
  var clean = String(txt || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  var firstBracket = clean.indexOf('[');
  var lastBracket = clean.lastIndexOf(']');
  if (firstBracket < 0 || lastBracket <= firstBracket) throw new Error('No JSON array in model response');
  var arr = JSON.parse(clean.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(arr)) throw new Error('Model response not an array');
  return arr;
}

function normalizePost(rawPost, cities) {
  var post = rawPost || {};
  var title = String(post.title || '').trim();
  var excerpt = String(post.excerpt || '').trim();
  var seoDescription = String(post.seo_description || '').trim();
  var bodyHtml = String(post.body_html || '').trim();
  if (!title || !excerpt || !seoDescription || !bodyHtml) return null;

  var city = post.city == null ? null : String(post.city).trim();
  if (city && cities.indexOf(city) === -1) city = null;

  var tags = [];
  if (Array.isArray(post.tags)) {
    for (var i = 0; i < post.tags.length; i += 1) {
      var tag = String(post.tags[i] || '').trim();
      if (!tag) continue;
      tags.push(tag);
      if (tags.length >= 6) break;
    }
  }

  return {
    slug: slugify(title),
    title: title,
    excerpt: excerpt,
    seo_description: seoDescription,
    body_html: bodyHtml,
    city: city,
    tags: tags,
    read_minutes: clampNumber(post.read_minutes, 3, 10, 4)
  };
}

async function generateBatch(cities, existingTitles, batchSize, preferredCity) {
  var targetCity = pickTargetCity(cities, preferredCity);
  var localRows = await getCityListingContext(targetCity, 8);
  var localNames = localRows.map(function (r) { return String((r && r.name) || '').trim(); }).filter(Boolean);
  var cityContext = buildCityContextBlock(targetCity, localRows);

  var system = [
    'You are the KiddBusy CMO content agent.',
    'Goal: organic SEO traffic from parents searching for weekend activities.',
    'Return strict JSON only as an array with exactly the requested number of post objects.',
    'No markdown fences. No commentary.',
    'Tone: playful, practical, parent-first.',
    'Each object keys: title, excerpt, seo_description, city, tags, read_minutes, body_html.',
    'Content must be locally grounded with real place names and specifics.'
  ].join(' ');

  var avoidTitles = Array.from(existingTitles).slice(-80).join(' | ') || 'none';
  var prompt = [
    'Generate exactly ' + String(batchSize) + ' unique blog posts for KiddBusy as a JSON array.',
    'Primary city for all posts in this batch: ' + targetCity + '.',
    cityContext,
    'Hard rules:',
    '- 220-380 words per post in body_html.',
    '- body_html may only use <p>, <h2>, <ul>, <li>, <strong>, <a>.',
    '- Title under 70 chars; excerpt 120-180 chars; seo_description 120-155 chars.',
    '- tags must be 4-6 items.',
    '- read_minutes integer 3-10.',
    '- city must be exactly "' + targetCity + '" (not null).',
    '- Include at least 3 specific free/public spaces by exact name from the Known local listings block.',
    '- Do not mention businesses, private venues, museums, zoos, ticketed attractions, classes, or paid admissions.',
    '- Include a <h2>Local Picks</h2> section with a <ul> and at least 3 <li> entries.',
    '- Include official site links when available in context.',
    '- Use full names as provided in context. Do not invent place names.',
    '- Include at least 1 very current time anchor in each post (this weekend, this month, or date range).',
    '- All posts must be materially different.',
    '- Avoid these existing titles: ' + avoidTitles
  ].join('\n');

  var models = getPreferredModels();
  var raw = '';
  var lastError = '';
  for (var m = 0; m < models.length; m += 1) {
    var modelName = models[m];
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 1400,
        temperature: 0.7,
        system: system,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    raw = await res.text();
    if (res.ok) break;
    lastError = 'model=' + modelName + ' status=' + String(res.status) + ' body=' + raw;
    if (res.status === 429) break;
  }
  if (!raw) throw new Error('Anthropic error: empty response');
  if (lastError && raw.indexOf('"type":"error"') >= 0) throw new Error('Anthropic error: ' + lastError);
  var arr = parseAnthropicArray(raw);

  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var n = normalizePost(arr[i], cities);
    if (!n) continue;
    if (n.city !== targetCity) continue;
    if (!hasStrongLocalSignals(n, targetCity, localNames)) continue;
    out.push(n);
    if (out.length >= batchSize) break;
  }
  return out;
}

async function insertDraft(post) {
  var row = {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    body_html: post.body_html,
    seo_description: post.seo_description,
    city: post.city || null,
    tags: post.tags,
    read_minutes: post.read_minutes,
    status: 'draft',
    source: 'cmo_agent',
    author: 'CMO Agent',
    // `published_at` is NOT NULL in schema, even for draft rows.
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  var first = await sbFetch('blog_posts', { method: 'POST', prefer: 'return=representation', body: row });
  if (first.response.ok) return Array.isArray(first.data) ? first.data[0] : first.data;

  if (first.response.status === 409) {
    row.slug = row.slug + '-' + String(Date.now()).slice(-6);
    var retry = await sbFetch('blog_posts', { method: 'POST', prefer: 'return=representation', body: row });
    if (retry.response.ok) return Array.isArray(retry.data) ? retry.data[0] : retry.data;
  }

  throw new Error('Failed to insert draft post: ' + JSON.stringify(first.data || {}));
}

async function countDraftsToday() {
  var start = startOfUtcDayIso();
  var q = 'blog_posts?select=id&status=eq.draft&source=eq.cmo_agent&created_at=gte.' + encodeURIComponent(start) + '&limit=300';
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data)) return 0;
  return result.data.length;
}

async function queueDepth() {
  var result = await sbFetch('blog_posts?select=id&status=eq.draft&source=eq.cmo_agent&limit=5000');
  if (!result.response.ok || !Array.isArray(result.data)) return 0;
  return result.data.length;
}

async function publishFromQueue(ratePerDay) {
  var rate = clampNumber(ratePerDay, 1, 20, 1);
  var q = 'blog_posts?select=id,slug,title,city,tags&status=eq.draft&source=eq.cmo_agent&order=created_at.asc&limit=' + String(rate);
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data) || result.data.length === 0) return [];

  var out = [];
  for (var i = 0; i < result.data.length; i += 1) {
    var row = result.data[i];
    var patch = await sbFetch('blog_posts?id=eq.' + encodeURIComponent(String(row.id)), {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        status: 'published',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
    if (patch.response.ok && Array.isArray(patch.data) && patch.data[0]) out.push(patch.data[0]);
  }
  return out;
}

async function publishByIds(ids) {
  var clean = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!clean.length) return [];
  var out = [];
  for (var i = 0; i < clean.length; i += 1) {
    var id = clean[i];
    var patch = await sbFetch('blog_posts?id=eq.' + encodeURIComponent(String(id)), {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        status: 'published',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
    if (patch.response.ok && Array.isArray(patch.data) && patch.data[0]) out.push(patch.data[0]);
  }
  return out;
}

async function getPublishedSeedPosts(limit) {
  var capped = clampNumber(limit, 1, 200, 40);
  var q = 'blog_posts?select=id,city,slug,title&source=eq.cmo_seed&status=eq.published&order=created_at.asc&limit=' + String(capped);
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data)) return [];
  return result.data;
}

async function getPublishedCmoPosts(limit) {
  var capped = clampNumber(limit, 1, 200, 40);
  var q = 'blog_posts?select=id,city,slug,title&source=eq.cmo_agent&status=eq.published&order=published_at.asc&limit=' + String(capped);
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data)) return [];
  return result.data;
}

async function getArchivedSeedPosts(limit) {
  var capped = clampNumber(limit, 1, 200, 40);
  var q = 'blog_posts?select=id,city,slug,title&source=eq.cmo_seed&status=eq.archived&order=updated_at.desc&limit=' + String(capped);
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data)) return [];
  return result.data;
}

async function archivePostsByIds(ids) {
  var clean = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!clean.length) return 0;
  var archived = 0;
  for (var i = 0; i < clean.length; i += 1) {
    var id = clean[i];
    var patch = await sbFetch('blog_posts?id=eq.' + encodeURIComponent(String(id)), {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        status: 'archived',
        updated_at: new Date().toISOString()
      }
    });
    if (patch.response.ok) archived += 1;
  }
  return archived;
}

async function runCmoBlog(event) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
      return json(500, { error: 'Missing required configuration' });
    }

    var ev = event || {};
    var headers = ev.headers || {};
    var method = String(ev.httpMethod || 'GET').toUpperCase();
    var body = {};
    if (method === 'POST') {
      try {
        body = JSON.parse(ev.body || '{}');
      } catch (e) {
        return json(400, { error: 'Invalid JSON body' });
      }
    }
    var isCron = method === 'GET';
    var source = String(headers['x-requested-from'] || headers['X-Requested-From'] || '').toLowerCase();
    var tokenMatch = !!(CMO_RUN_TOKEN && String(body.run_token || '') === CMO_RUN_TOKEN);
    if (!isCron && source !== 'kiddbusy-hq' && !tokenMatch) {
      return json(403, { error: 'Forbidden' });
    }

    var settings = await getSettings();
    var queueTarget = clampNumber(
      Object.prototype.hasOwnProperty.call(body, 'queue_target') ? body.queue_target : settings.blog_queue_target_per_day,
      1,
      200,
      50
    );
    var repairSeeded = !!body.repair_seeded;
    var repairPublishedCmo = !!body.repair_published_cmo;
    var repairAny = repairSeeded || repairPublishedCmo;
    var restoreSeeded = !!body.restore_seeded;
    var distributionEnabled = Object.prototype.hasOwnProperty.call(body, 'distribution_enabled')
      ? !!body.distribution_enabled
      : !!settings.blog_distribution_enabled;
    var forcePublishGenerated = Object.prototype.hasOwnProperty.call(body, 'force_publish_generated')
      ? !!body.force_publish_generated
      : !!repairAny;
    var publishRate = clampNumber(
      Object.prototype.hasOwnProperty.call(body, 'publish_rate') ? body.publish_rate : settings.blog_publish_rate_per_day,
      1,
      20,
      1
    );
    var maxGeneratePerRun = clampNumber(
      Object.prototype.hasOwnProperty.call(body, 'max_generate_per_run')
        ? body.max_generate_per_run
        : (repairAny ? 3 : 1),
      0,
      5,
      (repairAny ? 3 : 1)
    );
    var targetCity = Object.prototype.hasOwnProperty.call(body, 'target_city') ? String(body.target_city || '').trim() : '';

    var cities = await getCities();
    var identity = await getIdentitySets();
    var plannedCityRotation = [];
    var archivedSeedCount = 0;
    var archivedCmoCount = 0;
    var restoredSeedCount = 0;
    var seedBacklogCount = 0;
    var cmoBacklogCount = 0;
    var repairWindow = [];

    if (restoreSeeded) {
      var archivedRows = await getArchivedSeedPosts(100);
      if (archivedRows.length) {
        var restoreLimit = clampNumber(
          Object.prototype.hasOwnProperty.call(body, 'restore_limit') ? body.restore_limit : 10,
          1,
          100,
          10
        );
        var restoreIds = archivedRows.slice(0, restoreLimit).map(function (row) { return row.id; });
        var restored = await publishByIds(restoreIds);
        restoredSeedCount = restored.length;
      }
    }

    if (repairSeeded) {
      var seeded = await getPublishedSeedPosts(100);
      seedBacklogCount = seeded.length;
      if (seeded.length) {
        repairWindow = seeded.slice(0, maxGeneratePerRun);
        var seenSeedCities = {};
        for (var s = 0; s < repairWindow.length; s += 1) {
          var seedCity = String((repairWindow[s] && repairWindow[s].city) || '').trim();
          if (!seedCity) continue;
          var key = seedCity.toLowerCase();
          if (seenSeedCities[key]) continue;
          seenSeedCities[key] = true;
          plannedCityRotation.push(seedCity);
        }
        if (plannedCityRotation.length === 0 && cities.length) plannedCityRotation = cities.slice(0, 10);
      }
    }
    if (repairPublishedCmo) {
      var publishedCmo = await getPublishedCmoPosts(100);
      cmoBacklogCount = publishedCmo.length;
      if (publishedCmo.length) {
        repairWindow = publishedCmo.slice(0, maxGeneratePerRun);
        var seenCmoCities = {};
        for (var c = 0; c < repairWindow.length; c += 1) {
          var cmoCity = String((repairWindow[c] && repairWindow[c].city) || '').trim();
          if (!cmoCity) continue;
          var cKey = cmoCity.toLowerCase();
          if (seenCmoCities[cKey]) continue;
          seenCmoCities[cKey] = true;
          plannedCityRotation.push(cmoCity);
        }
        if (plannedCityRotation.length === 0 && cities.length) plannedCityRotation = cities.slice(0, 10);
      }
    }

    var already = await countDraftsToday();
    var remaining = queueTarget - already;
    if (remaining < 0) remaining = 0;
    if (remaining > 200) remaining = 200;
    if (remaining > maxGeneratePerRun) remaining = maxGeneratePerRun;
    if (repairAny && repairWindow.length > 0 && remaining < repairWindow.length) remaining = repairWindow.length;
    if (remaining > 80) remaining = 80;

    var generated = [];
    var generationErrors = [];
    var cityCursor = 0;
    while (remaining > 0) {
      var preferredCity = targetCity;
      if (plannedCityRotation.length) {
        preferredCity = plannedCityRotation[cityCursor % plannedCityRotation.length];
        cityCursor += 1;
      }
      var batchSize = plannedCityRotation.length ? 1 : (remaining > 5 ? 5 : remaining);
      var batch = [];
      try {
        batch = await generateBatch(cities, identity.titles, batchSize, preferredCity);
      } catch (e) {
        generationErrors.push('generate: ' + String(e.message || e));
        break;
      }

      if (!Array.isArray(batch) || batch.length === 0) break;
      for (var i = 0; i < batch.length; i += 1) {
        var post = batch[i];
        var titleKey = String(post.title || '').toLowerCase();
        var slugKey = String(post.slug || '').toLowerCase();
        if (!titleKey || identity.titles.has(titleKey)) continue;
        if (!slugKey || identity.slugs.has(slugKey)) continue;

        try {
          var saved = await insertDraft(post);
          generated.push(saved);
          identity.titles.add(titleKey);
          identity.slugs.add(String((saved && saved.slug) || post.slug || '').toLowerCase());
          remaining -= 1;
          if (remaining <= 0) break;
        } catch (e) {
          generationErrors.push('insert: ' + String(e.message || e));
        }
      }
      if (batch.length < batchSize) break;
    }

    var published = [];
    if (forcePublishGenerated && generated.length) {
      published = await publishByIds(generated.map(function (row) { return row.id; }));
    } else if (distributionEnabled) {
      published = await publishFromQueue(publishRate);
    }
    if (repairAny && repairWindow.length && generated.length) {
      var archiveCount = generated.length;
      if (archiveCount > repairWindow.length) archiveCount = repairWindow.length;
      var archived = await archivePostsByIds(repairWindow.slice(0, archiveCount).map(function (row) { return row.id; }));
      if (repairSeeded) archivedSeedCount = archived;
      if (repairPublishedCmo) archivedCmoCount = archived;
    }

    var depth = await queueDepth();
    await logAgentActivity({
      agentKey: 'cmo_agent',
      status: generationErrors.length ? 'warning' : 'success',
      summary: 'CMO blog queue run: generated ' + String(generated.length) + ', published ' + String(published.length) + ', queue depth ' + String(depth) + '.',
      details: {
        workflow: 'blog_queue_and_distribution',
        queue_target_per_day: queueTarget,
        distribution_enabled: distributionEnabled,
        publish_rate_per_day: publishRate,
        max_generate_per_run: maxGeneratePerRun,
        target_city: targetCity || null,
        repair_seeded: repairSeeded,
        repair_published_cmo: repairPublishedCmo,
        archived_seed_count: archivedSeedCount,
        archived_cmo_count: archivedCmoCount,
        restored_seed_count: restoredSeedCount,
        seed_backlog_count: seedBacklogCount,
        cmo_backlog_count: cmoBacklogCount,
        force_publish_generated: forcePublishGenerated,
        generated_count: generated.length,
        published_count: published.length,
        queue_depth: depth,
        generation_errors: generationErrors.slice(0, 6)
      }
    });

    return json(200, {
      success: true,
      queue_target_per_day: queueTarget,
      distribution_enabled: distributionEnabled,
      publish_rate_per_day: publishRate,
      max_generate_per_run: maxGeneratePerRun,
      target_city: targetCity || null,
      repair_seeded: repairSeeded,
      repair_published_cmo: repairPublishedCmo,
      archived_seed_count: archivedSeedCount,
      archived_cmo_count: archivedCmoCount,
      restored_seed_count: restoredSeedCount,
      seed_backlog_count: seedBacklogCount,
      cmo_backlog_count: cmoBacklogCount,
      force_publish_generated: forcePublishGenerated,
      generated_count: generated.length,
      published_count: published.length,
      queue_depth: depth,
      generation_errors: generationErrors,
      generated_slugs: generated.map(function (p) { return p.slug; }),
      published_slugs: published.map(function (p) { return p.slug; })
    });
  } catch (err) {
    try {
      await logAgentActivity({
        agentKey: 'cmo_agent',
        status: 'error',
        summary: 'CMO blog queue run failed: ' + String((err && err.message) || err),
        details: { workflow: 'blog_queue_and_distribution' }
      });
    } catch (ignore) {}

    return json(500, { error: String((err && err.message) || err || 'Unexpected error') });
  }
}

module.exports = { runCmoBlog };
