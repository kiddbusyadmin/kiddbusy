// netlify/functions/search.js
// Primary: Anthropic web search. Fallback: OpenAI web search.
// Returns normalized JSON payload in Anthropic-like shape:
// { provider, fallback_used, content: [{ type: 'text', text: '[...]' }] }

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_SEARCH_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env.OPENAI_SEARCH_MODEL || 'gpt-4.1-mini';
const OPENAI_WEB_SEARCH_TOOL_TYPES = String(process.env.OPENAI_WEB_SEARCH_TOOL_TYPES || 'web_search,web_search_preview')
  .split(',')
  .map(function (v) { return String(v || '').trim(); })
  .filter(Boolean);

const ACTIVITY_CATEGORIES = new Set([
  'Indoor Play',
  'Outdoor',
  "Children's Museum",
  'Library / Education',
  'Swimming',
  'Arts & Crafts',
  'Arcade / Gaming',
  'Sports',
  'Zoo / Animals',
  'Food & Treats',
  'Dance / Music',
  'Theater / Shows',
  'Parks',
  'Playgrounds',
  'Splash Pads'
]);

const AGE_SET = new Set(['toddler', 'school', 'teens']);
const TAG_SET = new Set(['indoor', 'outdoor', 'free', 'paid']);

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function safeString(v, maxLen) {
  return String(v == null ? '' : v).trim().slice(0, maxLen || 400);
}

function parseJsonArrayFromText(raw) {
  const cleaned = String(raw || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket < 0 || lastBracket <= firstBracket) {
    throw new Error('No JSON array found in model response');
  }
  const arr = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(arr)) throw new Error('Model payload is not an array');
  return arr;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function normalizeActivities(items) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i] || {};
    const name = safeString(row.name, 140);
    const category = safeString(row.category, 60);
    const emoji = safeString(row.emoji, 8);
    const desc = safeString(row.desc, 420);
    const addr = safeString(row.addr, 180);
    if (!name || !category || !desc || !addr) continue;
    if (!ACTIVITY_CATEGORIES.has(category)) continue;
    const ages = Array.isArray(row.ages) ? row.ages.map(function (a) { return safeString(a, 20).toLowerCase(); }).filter(function (a) { return AGE_SET.has(a); }) : [];
    const tags = Array.isArray(row.tags) ? row.tags.map(function (t) { return safeString(t, 20).toLowerCase(); }).filter(function (t) { return TAG_SET.has(t); }) : [];
    if (!ages.length) continue;
    let rating = Number(row.rating);
    if (!Number.isFinite(rating)) rating = 4.5;
    if (rating < 4) rating = 4;
    if (rating > 5) rating = 5;
    let reviewCount = Number(row.reviewCount);
    if (!Number.isFinite(reviewCount) || reviewCount < 1) reviewCount = 1;
    reviewCount = Math.floor(reviewCount);
    const open = row.open !== false;
    const dedupeKey = (name + '|' + addr).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      name: name,
      category: category,
      emoji: emoji || '🎯',
      desc: desc,
      addr: addr,
      open: open,
      ages: ages,
      tags: tags,
      rating: Math.round(rating * 10) / 10,
      reviewCount: reviewCount
    });
  }
  if (out.length < 8) {
    throw new Error('Insufficient valid activity results after validation');
  }
  return out.slice(0, 20);
}

function normalizeEvents(items) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const row = items[i] || {};
    const month = safeString(row.month, 6).toUpperCase();
    const day = safeString(row.day, 4);
    const name = safeString(row.name, 140);
    const detail = safeString(row.detail, 420);
    const sourceUrl = safeString(row.source_url, 500);
    const startDate = safeString(row.start_date, 20);
    const endDateRaw = row.end_date == null ? null : safeString(row.end_date, 20);
    if (!month || !day || !name || !detail || !sourceUrl || !startDate) continue;
    if (!/^https:\/\//i.test(sourceUrl)) continue;
    if (!isIsoDate(startDate)) continue;
    const endDate = endDateRaw && isIsoDate(endDateRaw) ? endDateRaw : null;
    const free = !!row.free;
    const ongoing = !!row.ongoing;
    const dedupeKey = (name + '|' + startDate).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      month: month,
      day: day,
      name: name,
      detail: detail,
      free: free,
      source_url: sourceUrl,
      start_date: startDate,
      end_date: endDate,
      ongoing: ongoing
    });
  }
  if (out.length < 3) {
    throw new Error('Insufficient valid event results after validation');
  }
  return out.slice(0, 8);
}

function collectAnthropicText(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return '';
  return contentBlocks
    .filter(function (b) { return b && b.type === 'text'; })
    .map(function (b) { return String(b.text || ''); })
    .join('\n');
}

function collectOpenAiText(data) {
  if (!data) return '';
  const chunks = [];
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    chunks.push(data.output_text);
  }
  if (Array.isArray(data.output)) {
    for (let i = 0; i < data.output.length; i += 1) {
      const item = data.output[i];
      if (!item) continue;
      if (typeof item.text === 'string') chunks.push(item.text);
      if (Array.isArray(item.content)) {
        for (let j = 0; j < item.content.length; j += 1) {
          const c = item.content[j];
          if (c && typeof c.text === 'string') chunks.push(c.text);
        }
      }
    }
  }
  return chunks.join('\n');
}

function buildPrompts(city, today, type) {
  if (type === 'activities') {
    return {
      system: [
        'You are KiddBusy, a family activity finder.',
        'Return ONLY a JSON array of exactly 20 objects.',
        'No markdown, no prose.',
        'Each object keys:',
        'name, category, emoji, desc, addr, open, ages, tags, rating, reviewCount.',
        'Use category exactly from allowed set:',
        'Indoor Play, Outdoor, Children\'s Museum, Library / Education, Swimming, Arts & Crafts, Arcade / Gaming, Sports, Zoo / Animals, Food & Treats, Dance / Music, Theater / Shows, Parks, Playgrounds, Splash Pads.',
        'Use ages subset: toddler, school, teens.',
        'Use tags subset: indoor, outdoor, free, paid.'
      ].join(' '),
      user: `Find 20 real kid-friendly activities in "${city}" good to visit today (${today}). Include variety and accurate addresses. Return only JSON array.`
    };
  }
  return {
    system: [
      'You are KiddBusy, a family event finder.',
      'Return ONLY a JSON array of exactly 8 upcoming event objects.',
      'No markdown, no prose.',
      'Each object keys:',
      'month, day, name, detail, free, source_url, start_date, end_date, ongoing.',
      'source_url must be direct event/source page and start with https://.',
      'start_date/end_date must be ISO YYYY-MM-DD.'
    ].join(' '),
    user: `Find 8 real upcoming kid-friendly events in "${city}" happening soon after today (${today}). Exclude past events unless ongoing=true and end_date is in the future. Return only JSON array.`
  };
}

async function callAnthropic(city, type, today) {
  if (!ANTHROPIC_KEY) throw new Error('Anthropic key missing');
  const prompts = buildPrompts(city, today, type);
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: type === 'activities' ? 4000 : 2200,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: prompts.system,
    messages: [{ role: 'user', content: prompts.user }]
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : ('Anthropic HTTP ' + res.status);
    throw new Error(msg);
  }
  const arr = parseJsonArrayFromText(collectAnthropicText(data.content));
  const normalized = type === 'activities' ? normalizeActivities(arr) : normalizeEvents(arr);
  return { provider: 'anthropic', items: normalized };
}

async function callOpenAiWithTool(city, type, today, toolType) {
  const prompts = buildPrompts(city, today, type);
  const request = {
    model: OPENAI_MODEL,
    input: [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user }
    ],
    tools: [{ type: toolType }],
    max_output_tokens: type === 'activities' ? 3000 : 1800
  };
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + OPENAI_KEY
    },
    body: JSON.stringify(request)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : ('OpenAI HTTP ' + res.status);
    throw new Error(msg);
  }
  const arr = parseJsonArrayFromText(collectOpenAiText(data));
  const normalized = type === 'activities' ? normalizeActivities(arr) : normalizeEvents(arr);
  return { provider: 'openai', items: normalized, tool_type: toolType };
}

async function callOpenAi(city, type, today) {
  if (!OPENAI_KEY) throw new Error('OpenAI key missing');
  let lastErr = null;
  const toolTypes = OPENAI_WEB_SEARCH_TOOL_TYPES.length ? OPENAI_WEB_SEARCH_TOOL_TYPES : ['web_search'];
  for (let i = 0; i < toolTypes.length; i += 1) {
    try {
      return await callOpenAiWithTool(city, type, today, toolTypes[i]);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('OpenAI fallback failed');
}

exports.handler = async function handler(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  if ((event.httpMethod || 'GET') !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const city = safeString(body.city, 100);
  const type = safeString(body.type, 20);
  const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  const providerOverride = source === 'kiddbusy-hq' ? safeString(body.provider_override, 20).toLowerCase() : '';
  if (!city) return json(400, { error: 'Invalid city' });
  if (type !== 'activities' && type !== 'events') {
    return json(400, { error: 'Invalid type' });
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  let anthropicErr = null;
  if (providerOverride !== 'openai') {
    try {
      const primary = await callAnthropic(city, type, today);
      return json(200, {
        provider: primary.provider,
        fallback_used: false,
        content: [{ type: 'text', text: JSON.stringify(primary.items) }]
      });
    } catch (err) {
      anthropicErr = err;
      if (providerOverride === 'anthropic') {
        return json(503, {
          error: 'Anthropic provider unavailable',
          primary_error: String(err && err.message ? err.message : err)
        });
      }
      console.warn('[search] anthropic failed, trying openai fallback:', err && err.message ? err.message : err);
    }
  }

  try {
    const secondary = await callOpenAi(city, type, today);
    return json(200, {
      provider: secondary.provider,
      fallback_used: true,
      fallback_reason: anthropicErr ? String(anthropicErr.message || anthropicErr) : 'primary_unavailable',
      tool_type: secondary.tool_type || null,
      content: [{ type: 'text', text: JSON.stringify(secondary.items) }]
    });
  } catch (fallbackErr) {
    console.error('[search] both providers failed:', {
      anthropic: anthropicErr ? String(anthropicErr.message || anthropicErr) : null,
      openai: String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr)
    });
    return json(503, {
      error: 'Search providers unavailable',
      primary_error: anthropicErr ? String(anthropicErr.message || anthropicErr) : null,
      fallback_error: String(fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr)
    });
  }
};
