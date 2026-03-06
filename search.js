// netlify/functions/search.js
// Proxies requests to Anthropic API — keeps the API key server-side.
// Called by the frontend as: POST /api/search

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { city, type } = body;
  if (!city || typeof city !== 'string' || city.length > 100) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid city' }) };
  }
  if (!['activities', 'events', 'reviews'].includes(type)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid type' }) };
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const ACTIVITIES_SYSTEM = `You are KiddBusy, a family activity finder. When given a city, return ONLY a JSON array of exactly 20 kid-friendly activity objects. No markdown, no explanation, just raw JSON.
Each object must have these exact keys:
- name (string)
- category (string, one of: "Indoor Play","Outdoor","Children's Museum","Library / Education","Swimming","Arts & Crafts","Arcade / Gaming","Sports","Zoo / Animals","Food & Treats","Dance / Music","Theater / Shows","Parks","Playgrounds","Splash Pads")
- emoji (single emoji matching category)
- desc (string, 1-2 sentences, why kids love it, include cost hint like Free/$/$$ and age notes)
- addr (string, short street address)
- open (boolean, true if likely open on a typical weekday)
- ages (array, subset of ["toddler","school","teens"])
- tags (array, subset of ["indoor","outdoor","free","paid"])
- rating (number between 4.0 and 5.0)
- reviewCount (integer, use 1)`;

  const EVENTS_SYSTEM = `You are KiddBusy, a family event finder. Return ONLY a JSON array of exactly 8 upcoming kid-friendly events. No markdown, no explanation, just raw JSON.
Each object must have these exact keys:
- month (string, 3-letter uppercase e.g. "MAR")
- day (string, 2-digit e.g. "08")
- name (string, event name)
- detail (string, format: "Venue · Address · Time · Brief description")
- free (boolean)`;

  const REVIEWS_SYSTEM = `You are generating realistic parent reviews for a family activity finder. Return ONLY a JSON array of strings. No markdown, no explanation, just raw JSON. Reviews should sound like real parents — casual, specific, varied length. No emojis. No fake enthusiasm. Mix of 1-3 sentences.`;

  const isActivities = type === 'activities';
  const isReviews = type === 'reviews';

  const requestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: isActivities ? 4000 : isReviews ? 1500 : 2000,
    ...(isActivities ? { tools: [{ type: 'web_search_20250305', name: 'web_search' }] } : {}),
    system: isActivities ? ACTIVITIES_SYSTEM : isReviews ? REVIEWS_SYSTEM : EVENTS_SYSTEM,
    messages: [{
      role: 'user',
      content: isActivities
        ? `Find 20 real, well-known kid-friendly activities in "${city}" good to visit today (${today}). Search the web for accurate, current places. Include a good variety of categories. Return only the JSON array.`
        : isReviews
        ? body.prompt
        : `Find 8 real upcoming kid-friendly events in "${city}" happening soon after today (${today}). Include story times, workshops, festivals, museum events. Use real upcoming dates. Return only the JSON array.`
    }]
  };

  // Retry up to 3 times with exponential backoff on rate limit
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      // Rate limited — wait and retry
      if (response.status === 529 || response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 3000;
        console.log(`Rate limited on attempt ${attempt + 1}, waiting ${waitMs}ms...`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(waitMs);
          continue;
        }
        return { statusCode: 503, body: JSON.stringify({ error: 'rate_limited' }) };
      }

      if (!response.ok) {
        console.error('Anthropic error:', data);
        return {
          statusCode: response.status,
          body: JSON.stringify({ error: data.error?.message || 'Anthropic API error' })
        };
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };

    } catch (err) {
      console.error(`Function error attempt ${attempt + 1}:`, err);
      if (attempt < MAX_RETRIES - 1) {
        await sleep((2 ** attempt) * 2000);
        continue;
      }
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }
};
