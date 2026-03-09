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

async function getCityOptions() {
  const { response, data } = await sbFetch('listings?select=city&status=eq.active&order=city.asc&limit=1000');
  if (!response.ok || !Array.isArray(data)) return ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Phoenix'];
  const unique = Array.from(new Set(data.map((r) => String(r.city || '').trim()).filter(Boolean)));
  return unique.length ? unique.slice(0, 25) : ['Houston', 'Dallas', 'Austin', 'San Antonio', 'Phoenix'];
}

async function hasPostToday() {
  const now = new Date();
  const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const { response, data } = await sbFetch(`blog_posts?select=id&status=eq.published&published_at=gte.${encodeURIComponent(startUtc)}&limit=1`);
  if (!response.ok) return false;
  return Array.isArray(data) && data.length > 0;
}

async function generatePost(cities) {
  const system = [
    'You are the KiddBusy CMO content agent.',
    'Goal: organic SEO traffic from parents searching for weekend kid activities.',
    'Return strict JSON only.',
    'No markdown fences.',
    'Tone: playful, practical, parent-first.',
    'Output keys: title, excerpt, seo_description, city, tags, read_minutes, body_html.'
  ].join(' ');

  const userPrompt = `Write one new blog post for KiddBusy. Target parents planning weekend activities. Candidate cities: ${cities.join(', ')}.\n\nRequirements:\n- 600-900 words of useful original content in body_html.\n- body_html must use only <p>, <h2>, <ul>, <li>, <strong>.\n- Include concrete planning tips.\n- No fake citations.\n- title under 65 chars.\n- excerpt 140-180 chars.\n- seo_description 120-155 chars.\n- 4 to 6 tags.\n- read_minutes integer 3 to 8.\n- city should be one city from list or null if generic.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2200,
      temperature: 0.7,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic error (${response.status}): ${raw}`);
  }

  let parsed;
  try {
    const body = JSON.parse(raw);
    const txt = Array.isArray(body.content)
      ? body.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
      : '';
    parsed = JSON.parse(txt);
  } catch (err) {
    throw new Error(`Failed to parse generated blog JSON: ${err.message}`);
  }

  if (!parsed || !parsed.title || !parsed.excerpt || !parsed.body_html || !parsed.seo_description) {
    throw new Error('Generated post missing required fields');
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  return {
    slug: slugify(parsed.title),
    title: String(parsed.title).trim(),
    excerpt: String(parsed.excerpt).trim(),
    body_html: String(parsed.body_html).trim(),
    seo_description: String(parsed.seo_description).trim(),
    city: parsed.city ? String(parsed.city).trim() : null,
    tags,
    read_minutes: Math.min(Math.max(Number(parsed.read_minutes) || 4, 3), 8)
  };
}

async function savePost(post) {
  const row = {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    body_html: post.body_html,
    seo_description: post.seo_description,
    city: post.city || null,
    tags: post.tags,
    read_minutes: post.read_minutes,
    status: 'published',
    source: 'cmo_agent',
    author: 'CMO Agent',
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { response, data } = await sbFetch('blog_posts', {
    method: 'POST',
    prefer: 'return=representation',
    body: row
  });

  if (!response.ok && response.status === 409) {
    row.slug = `${row.slug}-${Date.now().toString().slice(-6)}`;
    const retry = await sbFetch('blog_posts', {
      method: 'POST',
      prefer: 'return=representation',
      body: row
    });
    if (!retry.response.ok) {
      throw new Error(`Failed to insert blog post after slug retry: ${JSON.stringify(retry.data)}`);
    }
    return Array.isArray(retry.data) ? retry.data[0] : retry.data;
  }

  if (!response.ok) {
    throw new Error(`Failed to insert blog post: ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data[0] : data;
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

  try {
    if (await hasPostToday()) {
      const msg = 'CMO blog run skipped: a post is already published today.';
      await logAgentActivity({
        agentKey: 'cmo_agent',
        status: 'info',
        summary: msg,
        details: { workflow: 'blog_daily_publish', skipped: true }
      });
      return json(200, { success: true, skipped: true, message: msg });
    }

    const cities = await getCityOptions();
    const post = await generatePost(cities);
    const saved = await savePost(post);

    await logAgentActivity({
      agentKey: 'cmo_agent',
      status: 'success',
      summary: `Published blog post: ${saved.title}`,
      details: {
        workflow: 'blog_daily_publish',
        slug: saved.slug,
        city: saved.city || null,
        tags: saved.tags || []
      }
    });

    return json(200, { success: true, post: saved });
  } catch (err) {
    await logAgentActivity({
      agentKey: 'cmo_agent',
      status: 'error',
      summary: `CMO blog publish failed: ${err.message}`,
      details: { workflow: 'blog_daily_publish' }
    });
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
