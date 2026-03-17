const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_LEADS_MODEL = process.env.OWNER_LEADS_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_OWNER_LEADS_MODEL = process.env.OPENAI_OWNER_LEADS_MODEL || 'gpt-4.1-mini';
const OPENAI_WEB_SEARCH_TOOL_TYPES = String(process.env.OPENAI_WEB_SEARCH_TOOL_TYPES || 'web_search,web_search_preview')
  .split(',')
  .map((v) => String(v || '').trim())
  .filter(Boolean);
const { logAgentActivity } = require('./_agent-activity');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function isValidEmail(email) {
  const v = String(email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function uniqueStrings(list, max = 8) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const v = String(item || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeWebsiteUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v.slice(0, 500);
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v)) return `https://${v}`.slice(0, 500);
  return null;
}

function parseJsonFromText(raw) {
  const text = String(raw || '');
  const fenced = text.replace(/```json\s*/gi, '').replace(/```/g, '');
  const objMatch = fenced.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('No JSON object found in model output');
  return JSON.parse(objMatch[0]);
}

function parseJsonArrayFromText(raw) {
  const text = String(raw || '');
  const fenced = text.replace(/```json\s*/gi, '').replace(/```/g, '');
  const arrMatch = fenced.match(/\[[\s\S]*\]/);
  if (!arrMatch) throw new Error('No JSON array found in model output');
  return JSON.parse(arrMatch[0]);
}

function extractOpenAiText(data) {
  if (!data) return '';
  const chunks = [];
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    chunks.push(data.output_text);
  }
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item) continue;
      if (typeof item.text === 'string') chunks.push(item.text);
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && typeof c.text === 'string') chunks.push(c.text);
        }
      }
    }
  }
  return chunks.join('\n');
}

async function callAnthropicWebSearchJson({ system, user, maxTokens, expect }) {
  if (!ANTHROPIC_API_KEY) throw new Error('Anthropic key missing');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: OWNER_LEADS_MODEL,
      max_tokens: maxTokens,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const raw = await response.json();
  if (!response.ok) {
    throw new Error(raw && raw.error && raw.error.message ? raw.error.message : 'Anthropic API error');
  }
  const textBlocks = (raw.content || []).filter((b) => b.type === 'text');
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';
  const parsed = expect === 'array' ? parseJsonArrayFromText(text) : parseJsonFromText(text);
  return { provider: 'anthropic', model: OWNER_LEADS_MODEL, parsed, raw_response: raw };
}

async function callOpenAiWebSearchJson({ system, user, maxTokens, expect }) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI key missing');
  let lastErr = null;
  const toolTypes = OPENAI_WEB_SEARCH_TOOL_TYPES.length ? OPENAI_WEB_SEARCH_TOOL_TYPES : ['web_search'];
  for (const toolType of toolTypes) {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: OPENAI_OWNER_LEADS_MODEL,
          input: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          tools: [{ type: toolType }],
          max_output_tokens: maxTokens
        })
      });
      const rawText = await response.text();
      let raw = null;
      try { raw = rawText ? JSON.parse(rawText) : null; } catch (_) { raw = null; }
      if (!response.ok) {
        const msg = raw && raw.error && raw.error.message ? raw.error.message : `OpenAI HTTP ${response.status}`;
        throw new Error(msg);
      }
      const text = extractOpenAiText(raw);
      const parsed = expect === 'array' ? parseJsonArrayFromText(text) : parseJsonFromText(text);
      return { provider: 'openai', model: OPENAI_OWNER_LEADS_MODEL, parsed, raw_response: raw };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('OpenAI fallback failed');
}

async function callWebSearchJsonWithFallback({ system, user, maxTokens, expect }) {
  let primaryErr = null;
  try {
    return await callAnthropicWebSearchJson({ system, user, maxTokens, expect });
  } catch (err) {
    primaryErr = err;
  }
  try {
    return await callOpenAiWebSearchJson({ system, user, maxTokens, expect });
  } catch (fallbackErr) {
    const p = primaryErr ? String(primaryErr.message || primaryErr) : 'primary_failed';
    const f = fallbackErr ? String(fallbackErr.message || fallbackErr) : 'fallback_failed';
    throw new Error(`Anthropic+OpenAI failed (${p}; ${f})`);
  }
}

function normalizeLead(parsed, fallbackWebsite) {
  const lead = {
    owner_name: parsed && parsed.owner_name ? String(parsed.owner_name).trim().slice(0, 200) : null,
    contact_email: parsed && parsed.contact_email ? String(parsed.contact_email).trim().toLowerCase() : null,
    contact_phone: parsed && parsed.contact_phone ? String(parsed.contact_phone).trim().slice(0, 80) : null,
    business_website: normalizeWebsiteUrl((parsed && parsed.business_website) || fallbackWebsite),
    confidence: Number(parsed && parsed.confidence),
    notes: parsed && parsed.notes ? String(parsed.notes).trim().slice(0, 1200) : null,
    evidence_urls: uniqueStrings(parsed && parsed.evidence_urls, 6),
    raw_response: parsed && parsed.raw_response ? parsed.raw_response : null
  };

  if (!Number.isFinite(lead.confidence)) lead.confidence = 0;
  lead.confidence = Math.max(0, Math.min(1, lead.confidence));
  if (lead.contact_email && !isValidEmail(lead.contact_email)) {
    lead.notes = (lead.notes ? `${lead.notes} ` : '') + '[Invalid email discarded]';
    lead.contact_email = null;
  }
  return lead;
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
  const headers = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
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

async function fetchPreseedListings({ city, limit }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 200);
  const filters = [
    'select=listing_id,name,city,state,category,address,website,source,status',
    'status=eq.active',
    'source=eq.preseed',
    `limit=${safeLimit}`,
    'order=listing_id.asc'
  ];
  if (city) {
    const cityOnly = String(city).split(',')[0].trim();
    if (cityOnly) filters.push(`city=ilike.${encodeURIComponent(cityOnly)}`);
  }

  const { response, data } = await sbFetch(`listings?${filters.join('&')}`);
  if (!response.ok) {
    throw new Error(`Failed to load preseed listings: ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data : [];
}

async function enrichOneListing(listing) {
  const listingName = String(listing.name || '').trim();
  const city = String(listing.city || '').trim();
  const state = String(listing.state || '').trim();
  const website = String(listing.website || '').trim();
  const address = String(listing.address || '').trim();
  const category = String(listing.category || '').trim();

  const system = `You are a business lead researcher.
Return ONLY one JSON object with this exact schema:
{
  "owner_name": string | null,
  "contact_email": string | null,
  "contact_phone": string | null,
  "business_website": string | null,
  "confidence": number,
  "notes": string,
  "evidence_urls": string[]
}
Rules:
- Prioritize official website contact pages and trustworthy business directories.
- If you cannot find a reliable email, set contact_email to null.
- confidence must be between 0 and 1.
- evidence_urls must be URLs you used (max 6).
- No markdown. JSON only.`;

  const user = `Find likely owner/contact lead details for this business:
- Business: ${listingName}
- Category: ${category}
- City: ${city}
- State: ${state}
- Address: ${address || 'unknown'}
- Website: ${website || 'unknown'}

Goal: produce a suspected owner name and best contact email for outreach inviting business claim on KiddBusy.
If uncertain, lower confidence and explain briefly in notes.`;

  const llm = await callWebSearchJsonWithFallback({
    system,
    user,
    maxTokens: 1200,
    expect: 'object'
  });
  const parsed = llm.parsed;
  const lead = normalizeLead(parsed, website);
  lead.raw_response = llm.raw_response;
  lead.source_model = llm.model;
  return lead;
}

async function enrichListingBatch(listings) {
  const batch = Array.isArray(listings) ? listings : [];
  if (!batch.length) return {};

  const system = `You are a business lead researcher.
Return ONLY one JSON array.
Each item must use this exact schema:
{
  "listing_id": number,
  "owner_name": string | null,
  "contact_email": string | null,
  "contact_phone": string | null,
  "business_website": string | null,
  "confidence": number,
  "notes": string,
  "evidence_urls": string[]
}
Rules:
- One output item per input listing_id.
- Prioritize official website contact pages and trustworthy business directories.
- If you cannot find a reliable email, set contact_email to null.
- confidence must be between 0 and 1.
- evidence_urls max 6.
- No markdown. JSON only.`;

  const lines = batch.map((listing) => {
    return [
      `listing_id: ${Number(listing.listing_id) || 0}`,
      `name: ${String(listing.name || '').trim()}`,
      `category: ${String(listing.category || '').trim()}`,
      `city: ${String(listing.city || '').trim()}`,
      `state: ${String(listing.state || '').trim()}`,
      `address: ${String(listing.address || '').trim() || 'unknown'}`,
      `website: ${String(listing.website || '').trim() || 'unknown'}`
    ].join(' | ');
  }).join('\n');

  const user = `Find likely owner/contact lead details for each listing below:
${lines}

Goal: suspected owner name and best contact email for outreach inviting business claim on KiddBusy.
If uncertain, lower confidence and explain briefly in notes.`;

  const llm = await callWebSearchJsonWithFallback({
    system,
    user,
    maxTokens: 3600,
    expect: 'array'
  });
  const parsed = llm.parsed;
  if (!Array.isArray(parsed)) {
    throw new Error('Batch enrichment returned non-array payload');
  }

  const byId = {};
  for (const item of parsed) {
    const id = Number(item && item.listing_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId[id] = normalizeLead(item, null);
    byId[id].raw_response = llm.raw_response;
    byId[id].source_model = llm.model;
  }
  return byId;
}

async function maybeBackfillListingWebsite(listing, lead) {
  const currentWebsite = normalizeWebsiteUrl(listing && listing.website ? listing.website : null);
  const discoveredWebsite = normalizeWebsiteUrl(lead && lead.business_website ? lead.business_website : null);
  if (!discoveredWebsite || currentWebsite) {
    return { updated: false };
  }

  const { response, data } = await sbFetch(`listings?listing_id=eq.${encodeURIComponent(String(listing.listing_id))}`, {
    method: 'PATCH',
    body: { website: discoveredWebsite },
    prefer: 'return=representation'
  });
  if (!response.ok) {
    throw new Error(`Listing website backfill failed for ${listing.listing_id}: ${JSON.stringify(data)}`);
  }
  return { updated: true, website: discoveredWebsite };
}

async function upsertLead({ listing, lead }) {
  if (!lead.contact_email) {
    return { stored: false, reason: 'no_email' };
  }

  const now = new Date().toISOString();
  const row = {
    listing_id: listing.listing_id,
    listing_name: listing.name,
    city: listing.city || null,
    lead_name: lead.owner_name,
    lead_email: lead.contact_email,
    lead_phone: lead.contact_phone,
    business_website: lead.business_website,
    source_type: 'anthropic_web_search',
    source_model: String(lead.source_model || OWNER_LEADS_MODEL),
    confidence: lead.confidence,
    status: 'suspected',
    outreach_stage: 'uncontacted',
    evidence_urls: lead.evidence_urls || [],
    notes: lead.notes,
    raw_response: lead.raw_response,
    last_enriched_at: now,
    updated_at: now
  };

  const { response, data } = await sbFetch('owner_marketing_leads?on_conflict=listing_id,lead_email', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation'
  });

  if (!response.ok) {
    throw new Error(`Lead upsert failed for listing ${listing.listing_id}: ${JSON.stringify(data)}`);
  }

  return { stored: true, data: Array.isArray(data) ? data[0] : data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }
  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
    return json(500, { error: 'No LLM API key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY required)' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const action = String(body.action || '').trim();
  if (action !== 'enrich_preseed_owner_leads') {
    return json(400, { error: 'Unsupported action', supported_actions: ['enrich_preseed_owner_leads'] });
  }

  const city = body.city ? String(body.city).trim() : '';
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 200);
  const minConfidence = Math.max(0, Math.min(1, Number(body.min_confidence) || 0.65));
  const autoWrite = body.auto_write === undefined ? true : !!body.auto_write;
  const dryRun = body.dry_run === undefined ? !autoWrite : !!body.dry_run;
  const batchSize = Math.min(Math.max(Number(body.batch_size) || 6, 2), 15);

  try {
    const listings = await fetchPreseedListings({ city, limit });
    const results = [];
    let stored = 0;
    let websiteBackfilled = 0;
    let skippedNoEmail = 0;
    let skippedLowConfidence = 0;
    let failed = 0;

    for (let i = 0; i < listings.length; i += batchSize) {
      const chunk = listings.slice(i, i + batchSize);
      let chunkLeadMap = {};
      try {
        chunkLeadMap = await enrichListingBatch(chunk);
      } catch (batchErr) {
        // Fallback keeps pipeline resilient if one batch response is malformed.
        chunkLeadMap = {};
      }

      for (const listing of chunk) {
        try {
          const lead = chunkLeadMap[listing.listing_id] || await enrichOneListing(listing);
          const siteUpdate = await maybeBackfillListingWebsite(listing, lead);
          if (siteUpdate.updated) websiteBackfilled += 1;

          if (!lead.contact_email) {
            skippedNoEmail += 1;
            results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'skipped_no_email', confidence: lead.confidence, notes: lead.notes || null, website_backfilled: !!siteUpdate.updated, website: siteUpdate.website || lead.business_website || null });
            continue;
          }

          if (lead.confidence < minConfidence) {
            skippedLowConfidence += 1;
            results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'skipped_low_confidence', email: lead.contact_email, confidence: lead.confidence, website_backfilled: !!siteUpdate.updated, website: siteUpdate.website || lead.business_website || null });
            continue;
          }

          if (dryRun) {
            results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'dry_run_candidate', email: lead.contact_email, lead_name: lead.owner_name, confidence: lead.confidence, evidence_urls: lead.evidence_urls, website_backfilled: !!siteUpdate.updated, website: siteUpdate.website || lead.business_website || null });
            continue;
          }

          const upsert = await upsertLead({ listing, lead });
          if (upsert.stored) {
            stored += 1;
            results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'stored', email: lead.contact_email, lead_name: lead.owner_name, confidence: lead.confidence, website_backfilled: !!siteUpdate.updated, website: siteUpdate.website || lead.business_website || null });
          } else {
            results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'skipped', reason: upsert.reason || 'unknown' });
          }
        } catch (err) {
          failed += 1;
          results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'failed', error: err.message || 'unknown_error' });
        }
      }
    }

    await logAgentActivity({
      agentKey: 'owner_leads_enrichment_agent',
      status: 'success',
      summary: `Owner leads enrichment completed for ${city || 'all cities'}: scanned ${listings.length}, stored ${stored}, websites backfilled ${websiteBackfilled}, failed ${failed}.`,
      details: {
        city: city || null,
        auto_write: autoWrite,
        dry_run: dryRun,
        scanned: listings.length,
        stored,
        websites_backfilled: websiteBackfilled,
        skipped_no_email: skippedNoEmail,
        skipped_low_confidence: skippedLowConfidence,
        failed
      }
    });

    return json(200, {
      success: true,
      city: city || null,
      auto_write: autoWrite,
      dry_run: dryRun,
      scanned: listings.length,
      stored,
      websites_backfilled: websiteBackfilled,
      skipped_no_email: skippedNoEmail,
      skipped_low_confidence: skippedLowConfidence,
      failed,
      results
    });
  } catch (err) {
    await logAgentActivity({
      agentKey: 'owner_leads_enrichment_agent',
      status: 'error',
      summary: `Owner leads enrichment failed for ${city || 'all cities'}: ${String(err.message || 'unexpected error').slice(0, 800)}`
    });
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
