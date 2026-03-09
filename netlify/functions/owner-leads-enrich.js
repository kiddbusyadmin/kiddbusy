const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_LEADS_MODEL = process.env.OWNER_LEADS_MODEL || 'claude-sonnet-4-20250514';

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

function parseJsonFromText(raw) {
  const text = String(raw || '');
  const fenced = text.replace(/```json\s*/gi, '').replace(/```/g, '');
  const objMatch = fenced.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('No JSON object found in model output');
  return JSON.parse(objMatch[0]);
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: OWNER_LEADS_MODEL,
      max_tokens: 1200,
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
  const parsed = parseJsonFromText(text);

  const lead = {
    owner_name: parsed.owner_name ? String(parsed.owner_name).trim().slice(0, 200) : null,
    contact_email: parsed.contact_email ? String(parsed.contact_email).trim().toLowerCase() : null,
    contact_phone: parsed.contact_phone ? String(parsed.contact_phone).trim().slice(0, 80) : null,
    business_website: parsed.business_website ? String(parsed.business_website).trim().slice(0, 500) : (website || null),
    confidence: Number(parsed.confidence),
    notes: parsed.notes ? String(parsed.notes).trim().slice(0, 1200) : null,
    evidence_urls: uniqueStrings(parsed.evidence_urls, 6),
    raw_response: raw
  };

  if (!Number.isFinite(lead.confidence)) lead.confidence = 0;
  lead.confidence = Math.max(0, Math.min(1, lead.confidence));
  if (lead.contact_email && !isValidEmail(lead.contact_email)) {
    lead.notes = (lead.notes ? `${lead.notes} ` : '') + '[Invalid email discarded]';
    lead.contact_email = null;
  }

  return lead;
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
    source_model: OWNER_LEADS_MODEL,
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
  if (!ANTHROPIC_API_KEY) {
    return json(500, { error: 'ANTHROPIC_API_KEY missing' });
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

  try {
    const listings = await fetchPreseedListings({ city, limit });
    const results = [];
    let stored = 0;
    let skippedNoEmail = 0;
    let skippedLowConfidence = 0;
    let failed = 0;

    for (const listing of listings) {
      try {
        const lead = await enrichOneListing(listing);

        if (!lead.contact_email) {
          skippedNoEmail += 1;
          results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'skipped_no_email', confidence: lead.confidence, notes: lead.notes || null });
          continue;
        }

        if (lead.confidence < minConfidence) {
          skippedLowConfidence += 1;
          results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'skipped_low_confidence', email: lead.contact_email, confidence: lead.confidence });
          continue;
        }

        if (dryRun) {
          results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'dry_run_candidate', email: lead.contact_email, lead_name: lead.owner_name, confidence: lead.confidence, evidence_urls: lead.evidence_urls });
          continue;
        }

        const upsert = await upsertLead({ listing, lead });
        if (upsert.stored) {
          stored += 1;
          results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'stored', email: lead.contact_email, lead_name: lead.owner_name, confidence: lead.confidence });
        } else {
          results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'skipped', reason: upsert.reason || 'unknown' });
        }
      } catch (err) {
        failed += 1;
        results.push({ listing_id: listing.listing_id, listing_name: listing.name, status: 'failed', error: err.message || 'unknown_error' });
      }
    }

    return json(200, {
      success: true,
      city: city || null,
      auto_write: autoWrite,
      dry_run: dryRun,
      scanned: listings.length,
      stored,
      skipped_no_email: skippedNoEmail,
      skipped_low_confidence: skippedLowConfidence,
      failed,
      results
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
