const { logAgentActivity } = require('./_agent-activity');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CMO_RUN_TOKEN = process.env.CMO_RUN_TOKEN || process.env.ADMIN_PASSWORD || '';

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
  var q = 'listings?select=name,category,address,website&city=ilike.*' + safeCity + '*&status=eq.active&order=rating.desc.nullslast&limit=' + String(maxRows);
  var result = await sbFetch(q);
  if (!result.response.ok || !Array.isArray(result.data)) return [];
  return result.data;
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
    lines.push('- ' + String(r.name || 'Unknown Place') + ' | ' + String(r.category || 'activity') + ' | ' + String(r.address || 'no address'));
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

function hasStrongLocalSignals(post, targetCity, localListingNames) {
  var city = String(targetCity || '').trim().toLowerCase();
  var body = String((post && post.body_html) || '').toLowerCase();
  var title = String((post && post.title) || '').toLowerCase();
  var excerpt = String((post && post.excerpt) || '').toLowerCase();
  var combined = title + ' ' + excerpt + ' ' + body;

  if (!city || combined.indexOf(city) < 0) return false;

  var mentions = countNameMentions(combined, localListingNames || []);
  if (localListingNames && localListingNames.length) return mentions >= 2;

  // Fallback heuristic when no local listing names are available.
  var anchors = ['museum', 'park', 'library', 'zoo', 'children', 'downtown', 'neighborhood'];
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
  var localRows = await getCityListingContext(targetCity, 12);
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

  var avoidTitles = Array.from(existingTitles).slice(-300).join(' | ') || 'none';
  var prompt = [
    'Generate exactly ' + String(batchSize) + ' unique blog posts for KiddBusy as a JSON array.',
    'Primary city for all posts in this batch: ' + targetCity + '.',
    'Use web search for current local facts before writing.',
    cityContext,
    'Hard rules:',
    '- 220-380 words per post in body_html.',
    '- body_html may only use <p>, <h2>, <ul>, <li>, <strong>.',
    '- Title under 70 chars; excerpt 120-180 chars; seo_description 120-155 chars.',
    '- tags must be 4-6 items.',
    '- read_minutes integer 3-10.',
    '- city must be exactly "' + targetCity + '" (not null).',
    '- Include at least 3 specific local places by name in each post.',
    '- Include at least 1 very current time anchor in each post (this weekend, this month, or date range).',
    '- All posts must be materially different.',
    '- Avoid these existing titles: ' + avoidTitles
  ].join('\n');

  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2600,
      temperature: 0.7,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  var raw = await res.text();
  if (!res.ok) throw new Error('Anthropic error (' + String(res.status) + '): ' + raw);
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
    published_at: null,
    updated_at: new Date().toISOString()
  };

  var first = await sbFetch('blog_posts', { method: 'POST', prefer: 'return=representation', body: row });
  if (first.response.ok) return Array.isArray(first.data) ? first.data[0] : first.data;

  if (first.response.status === 409) {
    row.slug = row.slug + '-' + String(Date.now()).slice(-6);
    var retry = await sbFetch('blog_posts', { method: 'POST', prefer: 'return=representation', body: row });
    if (retry.response.ok) return Array.isArray(retry.data) ? retry.data[0] : retry.data;
  }

  throw new Error('Failed to insert draft post');
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
    var distributionEnabled = Object.prototype.hasOwnProperty.call(body, 'distribution_enabled')
      ? !!body.distribution_enabled
      : !!settings.blog_distribution_enabled;
    var publishRate = clampNumber(
      Object.prototype.hasOwnProperty.call(body, 'publish_rate') ? body.publish_rate : settings.blog_publish_rate_per_day,
      1,
      20,
      1
    );
    var maxGeneratePerRun = clampNumber(
      Object.prototype.hasOwnProperty.call(body, 'max_generate_per_run') ? body.max_generate_per_run : 1,
      0,
      5,
      1
    );
    var targetCity = Object.prototype.hasOwnProperty.call(body, 'target_city') ? String(body.target_city || '').trim() : '';

    var cities = await getCities();
    var identity = await getIdentitySets();

    var already = await countDraftsToday();
    var remaining = queueTarget - already;
    if (remaining < 0) remaining = 0;
    if (remaining > 200) remaining = 200;
    if (remaining > maxGeneratePerRun) remaining = maxGeneratePerRun;

    var generated = [];
    var generationErrors = [];
    while (remaining > 0) {
      var batchSize = remaining > 5 ? 5 : remaining;
      var batch = [];
      try {
        batch = await generateBatch(cities, identity.titles, batchSize, targetCity);
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
    if (distributionEnabled) published = await publishFromQueue(publishRate);

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
