const { logAgentActivity } = require('./_agent-activity');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
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

function startOfUtcDayIso(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)).toISOString();
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
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

async function getCmoSettings() {
  const { response, data } = await sbFetch('cmo_agent_settings?id=eq.1&select=blog_queue_target_per_day,blog_distribution_enabled,blog_publish_rate_per_day');
  if (!response.ok || !Array.isArray(data) || !data[0]) {
    return {
      blog_queue_target_per_day: 50,
      blog_distribution_enabled: true,
      blog_publish_rate_per_day: 1
    };
  }
  const row = data[0];
  return {
    blog_queue_target_per_day: Math.min(Math.max(Number(row.blog_queue_target_per_day) || 50, 1), 200),
    blog_distribution_enabled: row.blog_distribution_enabled !== false,
    blog_publish_rate_per_day: Math.min(Math.max(Number(row.blog_publish_rate_per_day) || 1, 1), 20)
  };
}

async function getCityOptions() {
  const { response, data } = await sbFetch('listings?select=city&status=eq.active&order=city.asc&limit=2000');
  if (!response.ok || !Array.isArray(data)) return ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Phoenix'];
  const unique = Array.from(new Set(data.map((r) => String(r.city || '').trim()).filter(Boolean)));
  return unique.length ? unique.slice(0, 40) : ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Phoenix'];
}

async function getExistingIdentitySet() {
  const { response, data } = await sbFetch('blog_posts?select=title,slug&order=created_at.desc&limit=5000');
  const titles = new Set();
  const slugs = new Set();
  if (response.ok && Array.isArray(data)) {
    data.forEach((r) => {
      const t = String(r.title || '').trim().toLowerCase();
      const s = String(r.slug || '').trim().toLowerCase();
      if (t) titles.add(t);
      if (s) slugs.add(s);
    });
  }
  return { titles, slugs };
}

function parseJSONArrayFromAnthropic(rawResponseText) {
  const body = JSON.parse(rawResponseText);
  const txt = Array.isArray(body.content)
    ? body.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
    : '';
  const clean = String(txt || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = clean.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array found in model response');
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr)) throw new Error('Model output is not an array');
  return arr;
}

function normalizePost(post, cities) {
  const cityRaw = post.city == null ? null : String(post.city).trim();
  const city = cityRaw && cities.includes(cityRaw) ? cityRaw : null;
  const tags = Array.isArray(post.tags) ? post.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 6) : [];
  const title = String(post.title || '').trim();
  const excerpt = String(post.excerpt || '').trim();
  const seo_description = String(post.seo_description || '').trim();
  const body_html = String(post.body_html || '').trim();
  if (!title || !excerpt || !seo_description || !body_html) return null;
  return {
    slug: slugify(title),
    title,
    excerpt,
    seo_description,
    body_html,
    city,
    tags,
    read_minutes: Math.min(Math.max(Number(post.read_minutes) || 4, 3), 10)
  };
}

async function generateBatchPosts({ cities, existingTitles, batchSize }) {
  const system = [
    'You are the KiddBusy CMO content agent.',
    'Goal: organic SEO traffic from parents searching for weekend activities.',
    'Return strict JSON only as an array with exactly the requested number of post objects.',
    'No markdown fences. No extra commentary.',
    'Tone: playful, practical, parent-first.',
    'Each object keys: title, excerpt, seo_description, city, tags, read_minutes, body_html.'
  ].join(' ');

  const avoidTitles = Array.from(existingTitles).slice(-400);
  const userPrompt = [
    `Generate exactly ${batchSize} unique blog posts for KiddBusy as a JSON array.`,
    `Candidate cities: ${cities.join(', ')}.`,
    'Hard rules:',
    '- 350-650 words per post in body_html.',
    '- body_html can only use <p>, <h2>, <ul>, <li>, <strong>.',
    '- Title under 70 chars; excerpt 120-180 chars; seo_description 120-155 chars.',
    '- tags must be 4-6 items.',
    '- read_minutes integer 3-10.',
    '- city must be one of the provided cities or null for generic.',
    '- All posts must be materially different and not near-duplicates.',
    '- Do not reuse these existing titles: ' + (avoidTitles.length ? avoidTitles.join(' | ') : 'none')
  ].join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 7000,
      temperature: 0.8,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic error (${response.status}): ${raw}`);
  }

  const arr = parseJSONArrayFromAnthropic(raw);
  const normalized = arr
    .map((p) => normalizePost(p, cities))
    .filter(Boolean)
    .slice(0, batchSize);
  return normalized;
}

async function insertDraftPost(post) {
  const base = {
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

  const first = await sbFetch('blog_posts', { method: 'POST', prefer: 'return=representation', body: base });
  if (first.response.ok) return Array.isArray(first.data) ? first.data[0] : first.data;

  if (first.response.status === 409) {
    const retryBody = { ...base, slug: `${base.slug}-${Date.now().toString().slice(-6)}` };
    const retry = await sbFetch('blog_posts', { method: 'POST', prefer: 'return=representation', body: retryBody });
    if (retry.response.ok) return Array.isArray(retry.data) ? retry.data[0] : retry.data;
  }

  throw new Error(`Failed to insert draft post: ${JSON.stringify(first.data)}`);
}

async function countDraftsCreatedToday() {
  const start = startOfUtcDayIso();
  const { response, data } = await sbFetch(`blog_posts?select=id&status=eq.draft&source=eq.cmo_agent&created_at=gte.${encodeURIComponent(start)}&limit=300`);
  if (!response.ok || !Array.isArray(data)) return 0;
  return data.length;
}

async function getQueueDepth() {
  const { response, data } = await sbFetch('blog_posts?select=id&status=eq.draft&source=eq.cmo_agent&limit=5000');
  if (!response.ok || !Array.isArray(data)) return 0;
  return data.length;
}

async function publishFromQueue(ratePerDay) {
  const safeRate = Math.min(Math.max(Number(ratePerDay) || 1, 1), 20);
  const { response, data } = await sbFetch(`blog_posts?select=id,slug,title,city,tags&status=eq.draft&source=eq.cmo_agent&order=created_at.asc&limit=${safeRate}`);
  if (!response.ok || !Array.isArray(data) || data.length === 0) return [];

  const published = [];
  for (const row of data) {
    const patch = await sbFetch(`blog_posts?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        status: 'published',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
    if (patch.response.ok && Array.isArray(patch.data) && patch.data[0]) published.push(patch.data[0]);
  }
  return published;
}

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    return json(500, { error: 'Missing required configuration' });
  }

  const isCron = event.httpMethod === 'GET';
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!isCron && source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }

  let body = {};
  if (event.httpMethod === 'POST') {
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
  }

  try {
    const settings = await getCmoSettings();
    const queueTarget = Math.min(Math.max(Number(body.queue_target || settings.blog_queue_target_per_day) || 50, 1), 200);
    const distributionEnabled = Object.prototype.hasOwnProperty.call(body, 'distribution_enabled')
      ? !!body.distribution_enabled
      : !!settings.blog_distribution_enabled;
    const publishRate = Math.min(Math.max(Number(body.publish_rate || settings.blog_publish_rate_per_day) || 1, 1), 20);

    const cities = await getCityOptions();
    const identity = await getExistingIdentitySet();

    const alreadyGeneratedToday = await countDraftsCreatedToday();
    let remainingToGenerate = Math.max(0, queueTarget - alreadyGeneratedToday);
    remainingToGenerate = Math.min(remainingToGenerate, 200);

    const generated = [];
    const generationErrors = [];

    while (remainingToGenerate > 0) {
      const batchSize = Math.min(5, remainingToGenerate);
      try {
        const batch = await generateBatchPosts({
          cities,
          existingTitles: identity.titles,
          batchSize
        });

        for (const post of batch) {
          const titleKey = String(post.title || '').toLowerCase();
          if (!titleKey || identity.titles.has(titleKey)) continue;
          const slugKey = String(post.slug || '').toLowerCase();
          if (!slugKey || identity.slugs.has(slugKey)) continue;

          try {
            const saved = await insertDraftPost(post);
            generated.push(saved);
            identity.titles.add(titleKey);
            identity.slugs.add(String(saved.slug || post.slug).toLowerCase());
            remainingToGenerate -= 1;
            if (remainingToGenerate <= 0) break;
          } catch (err) {
            generationErrors.push(`insert: ${err.message}`);
          }
        }

        if (!batch.length) break;
        if (batch.length < batchSize) break;
      } catch (err) {
        generationErrors.push(`generate: ${err.message}`);
        break;
      }
    }

    let published = [];
    if (distributionEnabled) {
      published = await publishFromQueue(publishRate);
    }

    const queueDepth = await getQueueDepth();

    await logAgentActivity({
      agentKey: 'cmo_agent',
      status: generationErrors.length ? 'warning' : 'success',
      summary: `CMO blog queue run: generated ${generated.length}, published ${published.length}, queue depth ${queueDepth}.`,
      details: {
        workflow: 'blog_queue_and_distribution',
        queue_target_per_day: queueTarget,
        distribution_enabled: distributionEnabled,
        publish_rate_per_day: publishRate,
        generated_count: generated.length,
        published_count: published.length,
        queue_depth: queueDepth,
        generation_errors: generationErrors.slice(0, 6)
      }
    });

    return json(200, {
      success: true,
      queue_target_per_day: queueTarget,
      distribution_enabled: distributionEnabled,
      publish_rate_per_day: publishRate,
      generated_count: generated.length,
      published_count: published.length,
      queue_depth: queueDepth,
      generation_errors: generationErrors,
      generated_slugs: generated.map((p) => p.slug),
      published_slugs: published.map((p) => p.slug)
    });
  } catch (err) {
    await logAgentActivity({
      agentKey: 'cmo_agent',
      status: 'error',
      summary: `CMO blog queue run failed: ${err.message}`,
      details: { workflow: 'blog_queue_and_distribution' }
    });
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
