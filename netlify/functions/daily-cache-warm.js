// KiddBusy – Daily Cache Warm
// Runs once per day at 3am ET via Netlify scheduled function.
// Refreshes listings for all top cities WITHOUT web search (cost optimized).
// Web search is only enabled for smaller/less-known cities.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.KB_DB_URL;
const SUPABASE_KEY = process.env.KB_DB_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Top cities refreshed daily — no web search needed, Haiku knows these well
const TOP_CITIES = [
  'Houston', 'Austin', 'Los Angeles', 'New York City', 'Chicago',
  'Denver', 'Columbus', 'Tampa', 'Orlando', 'Miami',
  'Atlanta', 'Nashville', 'Boston', 'Philadelphia', 'Seattle',
  'Phoenix', 'Las Vegas', 'San Diego', 'San Francisco', 'Charlotte',
  'Minneapolis', 'Portland', 'New Orleans', 'Honolulu', 'Memphis'
];

// Smaller/newer cities get web search for accuracy
const USE_WEB_SEARCH_CITIES = new Set([
  'Raleigh', 'Salt Lake City', 'Indianapolis', 'Kansas City',
  'Buffalo', 'Jersey City', 'Louisville', 'Richmond', 'Boise', 'Tucson'
]);

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAI(city, useWebSearch) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3200,
    system: ACTIVITIES_SYSTEM,
    messages: [{
      role: 'user',
      content: useWebSearch
        ? `Find 20 real, well-known kid-friendly activities in "${city}" good to visit today (${today}). Search the web for accurate, current places. Include a good variety of categories. Return only the JSON array.`
        : `List 20 well-known kid-friendly activities in "${city}". Include a good variety of categories. Return only the JSON array.`
    }]
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const MAX_RETRIES = 3;
  for (let attempt
