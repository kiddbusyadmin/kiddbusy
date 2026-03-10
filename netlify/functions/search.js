// netlify/functions/search.js
// Proxies requests to Anthropic API — keeps the API key server-side.
// Called by the frontend as: POST /api/search

// Extend function timeout to 60s (AI calls can take 20-30s with web search)
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
  if (!['activities', 'events'].includes(type)) {
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
- free (boolean)
- source_url (string, direct event page URL or primary source page URL, must start with https://)
- start_date (string, ISO date YYYY-MM-DD)
- end_date (string, ISO date YYYY-MM-DD or null)
- ongoing (boolean, true only if event is currently ongoing)`;

  const isActivities = type === 'activities';

  const requestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: isActivities ? 4000 : 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: isActivities ? ACTIVITIES_SYSTEM : EVENTS_SYSTEM,
    messages: [{
      role: 'user',
      content: isActivities
        ? `Find 20 real, well-known kid-friendly activities in "${city}" good to visit today (${today}). Search the web for accurate, current places. Include a good variety of categories. Return only the JSON array.`
        : `Find 8 real upcoming kid-friendly events in "${city}" happening soon after today (${today}). Include story times, workshops, festivals, museum events. Exclude past events unless ongoing=true and end_date is in the future. Include direct source_url for each event. Return only the JSON array.`
    }]
  };

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
    console.error('Function error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
