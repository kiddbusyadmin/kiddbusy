const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const DEFAULT_CANDIDATES_PER_LISTING = Number(process.env.PHOTO_CANDIDATES_PER_LISTING || 3);
const DEFAULT_PHOTOS_PER_LISTING = Number(process.env.PHOTO_PHOTOS_PER_LISTING || 1);
const DEFAULT_PROVIDER_COST_PER_1000 = Number(process.env.PHOTO_PROVIDER_COST_PER_1000 || 5);
const DEFAULT_PROVIDER_ITEMS_PER_CALL = Number(process.env.PHOTO_PROVIDER_ITEMS_PER_CALL || 1);
const PHOTO_BUCKET = process.env.PHOTO_UPLOAD_BUCKET || 'listing-photos';
const PHOTO_UPLOAD_MAX_BYTES = Number(process.env.PHOTO_UPLOAD_MAX_BYTES || 6291456);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function normalizeCity(city) {
  return String(city || '').split(',')[0].trim().toLowerCase();
}

function cleanSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeCityInput(cities) {
  if (!Array.isArray(cities)) return [];
  return cities
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 250);
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function stripDataUriPrefix(base64) {
  const input = String(base64 || '').trim();
  const idx = input.indexOf(',');
  if (input.startsWith('data:') && idx !== -1) {
    return input.slice(idx + 1);
  }
  return input;
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

async function uploadBinaryToStorage(path, bytes, mimeType) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: bytes
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

async function findListingIdByBusinessAndCity(businessName, city) {
  const name = String(businessName || '').trim();
  const normalizedCity = normalizeCity(city);
  if (!name || !normalizedCity) return null;

  const encodedName = encodeURIComponent(name);
  const encodedCity = encodeURIComponent(normalizedCity);

  const { response, data } = await sbFetch(`listings?select=listing_id,name,city,status&status=eq.active&name=ilike.${encodedName}&city=ilike.${encodedCity}&limit=1`);
  if (!response.ok) return null;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0].listing_id;
}

async function promoteListingPhoto({ listingId, sourceUrl, cdnUrl, provider, attributionName, attributionUrl, width, height, note }) {
  const now = new Date().toISOString();
  const finalUrl = String(cdnUrl || sourceUrl || '').trim();
  if (!finalUrl) throw new Error('Missing final photo URL for promotion');

  await sbFetch(`listing_photos?listing_id=eq.${encodeURIComponent(String(listingId))}&status=eq.active`, {
    method: 'PATCH',
    body: { status: 'superseded', reviewed_at: now },
    prefer: 'return=minimal'
  });

  const candidateRow = {
    listing_id: listingId,
    provider: String(provider || 'owner_upload').slice(0, 80),
    source_url: sourceUrl || finalUrl,
    cdn_url: finalUrl,
    status: 'active',
    attribution_name: attributionName ? String(attributionName).slice(0, 160) : null,
    attribution_url: attributionUrl ? String(attributionUrl).slice(0, 500) : null,
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    reviewed_at: now,
    approved_at: now,
    raw_payload: note ? { note } : null
  };

  const { response: candidateResp, data: candidateData } = await sbFetch('listing_photos?on_conflict=listing_id,source_url', {
    method: 'POST',
    body: candidateRow,
    prefer: 'resolution=merge-duplicates,return=representation'
  });

  if (!candidateResp.ok) {
    throw new Error(`Failed to promote listing photo: ${JSON.stringify(candidateData)}`);
  }

  const listingUpdate = {
    photo_url: finalUrl,
    photo_source: String(provider || 'owner_upload').slice(0, 80),
    photo_status: 'active',
    photo_updated_at: now,
    photo_attribution_name: attributionName ? String(attributionName).slice(0, 160) : null,
    photo_attribution_url: attributionUrl ? String(attributionUrl).slice(0, 500) : null,
    photo_width: width ? Number(width) : null,
    photo_height: height ? Number(height) : null
  };

  const { response: listingResp, data: listingData } = await sbFetch(`listings?listing_id=eq.${encodeURIComponent(String(listingId))}`, {
    method: 'PATCH',
    body: listingUpdate,
    prefer: 'return=representation'
  });

  if (!listingResp.ok) {
    throw new Error(`Failed to update listing with approved photo: ${JSON.stringify(listingData)}`);
  }

  return {
    listing: Array.isArray(listingData) ? listingData[0] : listingData,
    photo: Array.isArray(candidateData) ? candidateData[0] : candidateData
  };
}

function buildEstimate(rows, cities, options) {
  const filterSet = new Set(cities.map(normalizeCity));
  const byCity = {};

  for (const row of rows || []) {
    const cityName = String(row.city || '').trim();
    if (!cityName) continue;
    if (filterSet.size > 0 && !filterSet.has(normalizeCity(cityName))) continue;
    if (!byCity[cityName]) byCity[cityName] = { city: cityName, listings: 0 };
    byCity[cityName].listings += 1;
  }

  const perCity = Object.values(byCity).sort((a, b) => b.listings - a.listings || a.city.localeCompare(b.city));
  const listingCount = perCity.reduce((sum, row) => sum + row.listings, 0);

  const photosTarget = listingCount * options.photosPerListing;
  const candidatePulls = listingCount * options.candidatesPerListing;
  const estimatedCalls = Math.ceil(candidatePulls / Math.max(options.providerItemsPerCall, 1));
  const estimatedCostUsd = (estimatedCalls / 1000) * options.providerCostPer1000;

  return {
    provider: options.provider,
    assumptions: {
      photos_per_listing: options.photosPerListing,
      candidates_per_listing: options.candidatesPerListing,
      provider_items_per_call: options.providerItemsPerCall,
      provider_cost_per_1000_calls: options.providerCostPer1000
    },
    totals: {
      cities: perCity.length,
      listings: listingCount,
      photos_target: photosTarget,
      candidate_pulls: candidatePulls,
      estimated_api_calls: estimatedCalls,
      estimated_cost_usd: Number(estimatedCostUsd.toFixed(4))
    },
    per_city: perCity.map((c) => {
      const cityCandidatePulls = c.listings * options.candidatesPerListing;
      const cityCalls = Math.ceil(cityCandidatePulls / Math.max(options.providerItemsPerCall, 1));
      const cityCost = (cityCalls / 1000) * options.providerCostPer1000;
      return {
        city: c.city,
        listings: c.listings,
        photos_target: c.listings * options.photosPerListing,
        candidate_pulls: cityCandidatePulls,
        estimated_api_calls: cityCalls,
        estimated_cost_usd: Number(cityCost.toFixed(4))
      };
    })
  };
}

async function estimateCoverage(payload) {
  const cities = normalizeCityInput(payload.cities);
  const options = {
    provider: String(payload.provider || 'unspecified').trim() || 'unspecified',
    photosPerListing: parsePositiveInt(payload.photos_per_listing, DEFAULT_PHOTOS_PER_LISTING),
    candidatesPerListing: parsePositiveInt(payload.candidates_per_listing, DEFAULT_CANDIDATES_PER_LISTING),
    providerCostPer1000: parseNonNegativeNumber(payload.provider_cost_per_1000, DEFAULT_PROVIDER_COST_PER_1000),
    providerItemsPerCall: parsePositiveInt(payload.provider_items_per_call, DEFAULT_PROVIDER_ITEMS_PER_CALL)
  };

  const { response, data } = await sbFetch('listings?select=listing_id,city,status&status=eq.active&limit=5000');
  if (!response.ok) {
    return json(response.status, { error: 'Failed to query listings', details: data });
  }

  return json(200, buildEstimate(data || [], cities, options));
}

async function queueBackfill(payload) {
  const cities = normalizeCityInput(payload.cities);
  if (!cities.length) {
    return json(400, { error: 'cities array is required' });
  }

  const options = {
    provider: String(payload.provider || 'unspecified').trim() || 'unspecified',
    photosPerListing: parsePositiveInt(payload.photos_per_listing, DEFAULT_PHOTOS_PER_LISTING),
    candidatesPerListing: parsePositiveInt(payload.candidates_per_listing, DEFAULT_CANDIDATES_PER_LISTING),
    providerCostPer1000: parseNonNegativeNumber(payload.provider_cost_per_1000, DEFAULT_PROVIDER_COST_PER_1000),
    providerItemsPerCall: parsePositiveInt(payload.provider_items_per_call, DEFAULT_PROVIDER_ITEMS_PER_CALL),
    requestedBy: String(payload.requested_by || 'admin').slice(0, 120)
  };

  const { response: listingsResp, data: listingsRows } = await sbFetch('listings?select=listing_id,city,status&status=eq.active&limit=5000');
  if (!listingsResp.ok) {
    return json(listingsResp.status, { error: 'Failed to query listings', details: listingsRows });
  }

  const estimate = buildEstimate(listingsRows || [], cities, options);
  const byCityCount = {};
  for (const row of estimate.per_city) byCityCount[normalizeCity(row.city)] = row.listings;

  const jobs = cities.map((city) => {
    const cityListings = byCityCount[normalizeCity(city)] || 0;
    const cityCandidatePulls = cityListings * options.candidatesPerListing;
    const cityCalls = Math.ceil(cityCandidatePulls / Math.max(options.providerItemsPerCall, 1));
    const cityCost = (cityCalls / 1000) * options.providerCostPer1000;

    return {
      city,
      provider: options.provider,
      status: 'queued',
      listings_target: cityListings,
      photos_per_listing: options.photosPerListing,
      candidates_per_listing: options.candidatesPerListing,
      estimated_calls: cityCalls,
      estimated_cost_usd: Number(cityCost.toFixed(4)),
      requested_by: options.requestedBy,
      metadata: {
        note: 'Queued by photo-admin endpoint',
        created_from: 'queue_backfill'
      }
    };
  });

  const { response: insertResp, data: inserted } = await sbFetch('photo_ingestion_jobs', {
    method: 'POST',
    body: jobs,
    prefer: 'return=representation'
  });

  if (!insertResp.ok) {
    return json(insertResp.status, {
      error: 'Failed to queue jobs. Run photo migration SQL first if table is missing.',
      details: inserted
    });
  }

  return json(200, {
    queued: inserted ? inserted.length : 0,
    jobs: inserted || [],
    estimate
  });
}

async function listJobs(payload) {
  const limit = Math.min(parsePositiveInt(payload.limit, 25), 200);
  const { response, data } = await sbFetch(`photo_ingestion_jobs?select=*&order=created_at.desc&limit=${limit}`);
  if (!response.ok) {
    return json(response.status, {
      error: 'Failed to query jobs. Run photo migration SQL first if table is missing.',
      details: data
    });
  }
  return json(200, { count: Array.isArray(data) ? data.length : 0, jobs: data || [] });
}

async function addPhotoCandidate(payload) {
  const listingId = Number(payload.listing_id);
  const sourceUrl = String(payload.source_url || '').trim();
  if (!Number.isFinite(listingId) || listingId <= 0) {
    return json(400, { error: 'listing_id is required' });
  }
  if (!sourceUrl) {
    return json(400, { error: 'source_url is required' });
  }

  const row = {
    listing_id: listingId,
    provider: String(payload.provider || 'unspecified').slice(0, 80),
    source_url: sourceUrl,
    cdn_url: payload.cdn_url ? String(payload.cdn_url) : null,
    status: 'candidate',
    attribution_name: payload.attribution_name ? String(payload.attribution_name).slice(0, 160) : null,
    attribution_url: payload.attribution_url ? String(payload.attribution_url).slice(0, 500) : null,
    license: payload.license ? String(payload.license).slice(0, 120) : null,
    width: payload.width ? Number(payload.width) : null,
    height: payload.height ? Number(payload.height) : null,
    score: payload.score != null ? Number(payload.score) : null,
    raw_payload: payload.raw_payload && typeof payload.raw_payload === 'object' ? payload.raw_payload : null
  };

  const { response, data } = await sbFetch('listing_photos?on_conflict=listing_id,source_url', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation'
  });

  if (!response.ok) {
    return json(response.status, {
      error: 'Failed to upsert candidate. Run photo migration SQL first if table is missing.',
      details: data
    });
  }

  return json(200, { success: true, data });
}

async function setCandidateStatus(payload, status) {
  const photoId = Number(payload.photo_id);
  if (!Number.isFinite(photoId) || photoId <= 0) {
    return json(400, { error: 'photo_id is required' });
  }

  const { response: getResp, data: rows } = await sbFetch(`listing_photos?photo_id=eq.${encodeURIComponent(String(photoId))}&select=photo_id,listing_id,source_url,cdn_url,status`);
  if (!getResp.ok) {
    return json(getResp.status, { error: 'Failed to read candidate', details: rows });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return json(404, { error: 'Candidate not found' });
  }

  const row = rows[0];

  const updates = {
    status,
    reviewed_at: new Date().toISOString(),
    rejected_reason: status === 'rejected' ? String(payload.reason || 'Rejected by admin').slice(0, 400) : null,
    approved_at: status === 'active' ? new Date().toISOString() : null
  };

  const { response: patchResp, data: patched } = await sbFetch(`listing_photos?photo_id=eq.${encodeURIComponent(String(photoId))}`, {
    method: 'PATCH',
    body: updates,
    prefer: 'return=representation'
  });

  if (!patchResp.ok) {
    return json(patchResp.status, { error: `Failed to set candidate ${status}`, details: patched });
  }

  if (status === 'active') {
    try {
      const promoted = await promoteListingPhoto({
        listingId: row.listing_id,
        sourceUrl: row.source_url,
        cdnUrl: payload.cdn_url ? String(payload.cdn_url).trim() : (row.cdn_url || row.source_url),
        provider: 'listing_photos',
        attributionName: payload.attribution_name,
        attributionUrl: payload.attribution_url,
        note: 'Approved via setCandidateStatus'
      });
      return json(200, { success: true, candidate: patched, listing: promoted.listing });
    } catch (err) {
      return json(500, { error: err.message || 'Failed to promote candidate photo', candidate: patched });
    }
  }

  return json(200, { success: true, candidate: patched });
}

async function listCandidates(payload) {
  const listingId = payload.listing_id != null ? Number(payload.listing_id) : null;
  const status = payload.status ? String(payload.status).trim() : null;
  const limit = Math.min(parsePositiveInt(payload.limit, 50), 500);

  const filters = ['select=*', 'order=created_at.desc', `limit=${limit}`];
  if (Number.isFinite(listingId) && listingId > 0) {
    filters.push(`listing_id=eq.${encodeURIComponent(String(listingId))}`);
  }
  if (status) {
    filters.push(`status=eq.${encodeURIComponent(status)}`);
  }

  const { response, data } = await sbFetch(`listing_photos?${filters.join('&')}`);
  if (!response.ok) {
    return json(response.status, {
      error: 'Failed to query candidates. Run photo migration SQL first if table is missing.',
      details: data
    });
  }
  return json(200, { count: Array.isArray(data) ? data.length : 0, photos: data || [] });
}

async function submitSubmissionPhoto(payload) {
  const businessName = String(payload.business_name || '').trim();
  const city = String(payload.city || '').trim();
  const isOwner = !!payload.is_owner;
  const mimeType = String(payload.mime_type || 'image/jpeg').slice(0, 80);
  const fileName = String(payload.file_name || 'upload.jpg').slice(0, 160);
  const base64Raw = stripDataUriPrefix(payload.file_base64);

  if (!businessName || !city || !base64Raw) {
    return json(400, { error: 'business_name, city, and file_base64 are required' });
  }

  const bytes = Buffer.from(base64Raw, 'base64');
  if (!bytes || !bytes.length) {
    return json(400, { error: 'Invalid image payload' });
  }
  if (bytes.length > PHOTO_UPLOAD_MAX_BYTES) {
    return json(413, { error: `Image too large. Max bytes: ${PHOTO_UPLOAD_MAX_BYTES}` });
  }

  const ext = (String(fileName).toLowerCase().split('.').pop() || 'jpg').replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg';
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const path = `${cleanSegment(city)}/${cleanSegment(businessName)}/${yyyy}/${mm}/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;

  const storageUpload = await uploadBinaryToStorage(path, bytes, mimeType);
  if (!storageUpload.response.ok) {
    return json(storageUpload.response.status, {
      error: `Failed to upload image to storage bucket '${PHOTO_BUCKET}'. Ensure bucket exists via migration.`,
      details: storageUpload.data
    });
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;

  let listingId = Number(payload.listing_id) > 0 ? Number(payload.listing_id) : null;
  if (!listingId) {
    listingId = await findListingIdByBusinessAndCity(businessName, city);
  }

  const submissionStatus = isOwner ? 'auto_approved' : 'pending';
  const submissionRow = {
    listing_id: listingId,
    business_name: businessName,
    city,
    submitter_name: payload.submitter_name ? String(payload.submitter_name).slice(0, 160) : null,
    submitter_email: payload.submitter_email ? String(payload.submitter_email).slice(0, 200) : null,
    source_url: publicUrl,
    status: submissionStatus,
    is_owner: isOwner,
    provider: 'owner_upload',
    mime_type: mimeType,
    file_size_bytes: bytes.length,
    reviewed_at: isOwner ? new Date().toISOString() : null,
    notes: isOwner ? 'Auto-approved owner upload from submission form' : null
  };

  const { response: subResp, data: subData } = await sbFetch('submission_photos', {
    method: 'POST',
    body: submissionRow,
    prefer: 'return=representation'
  });

  if (!subResp.ok) {
    return json(subResp.status, {
      error: 'Image uploaded but failed to record submission_photos row. Run migration first.',
      details: subData,
      uploaded_url: publicUrl
    });
  }

  let promoted = null;
  if (isOwner && listingId) {
    try {
      promoted = await promoteListingPhoto({
        listingId,
        sourceUrl: publicUrl,
        cdnUrl: publicUrl,
        provider: 'owner_upload',
        note: 'Auto-approved owner submission upload'
      });
    } catch (err) {
      return json(500, {
        error: 'Owner image was uploaded, but publish-to-listing failed',
        details: err.message || String(err),
        uploaded_url: publicUrl,
        submission_photo: Array.isArray(subData) ? subData[0] : subData
      });
    }
  }

  return json(200, {
    success: true,
    uploaded_url: publicUrl,
    bucket: PHOTO_BUCKET,
    path,
    listing_id: listingId,
    auto_published: !!(isOwner && listingId),
    submission_photo: Array.isArray(subData) ? subData[0] : subData,
    listing: promoted ? promoted.listing : null
  });
}

async function listSubmissionPhotos(payload) {
  const limit = Math.min(parsePositiveInt(payload.limit, 100), 500);
  const status = payload.status ? String(payload.status).trim() : '';
  const filters = ['select=*', 'order=created_at.desc', `limit=${limit}`];
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);

  const { response, data } = await sbFetch(`submission_photos?${filters.join('&')}`);
  if (!response.ok) {
    return json(response.status, {
      error: 'Failed to query submission photos. Run migration first.',
      details: data
    });
  }

  return json(200, { count: Array.isArray(data) ? data.length : 0, photos: data || [] });
}

async function approveSubmissionPhoto(payload) {
  const submissionPhotoId = Number(payload.submission_photo_id);
  if (!Number.isFinite(submissionPhotoId) || submissionPhotoId <= 0) {
    return json(400, { error: 'submission_photo_id is required' });
  }

  const { response: getResp, data: rows } = await sbFetch(`submission_photos?submission_photo_id=eq.${encodeURIComponent(String(submissionPhotoId))}&select=*`);
  if (!getResp.ok) return json(getResp.status, { error: 'Failed to read submission photo', details: rows });
  if (!Array.isArray(rows) || rows.length === 0) return json(404, { error: 'Submission photo not found' });

  const row = rows[0];
  let listingId = Number(payload.listing_id) > 0 ? Number(payload.listing_id) : Number(row.listing_id || 0);
  if (!listingId) {
    listingId = await findListingIdByBusinessAndCity(row.business_name, row.city);
  }

  if (!listingId) {
    return json(409, {
      error: 'No listing match found. Provide listing_id to approve this image.',
      submission_photo: row
    });
  }

  let promoted;
  try {
    promoted = await promoteListingPhoto({
      listingId,
      sourceUrl: row.source_url,
      cdnUrl: row.source_url,
      provider: row.provider || 'submission_photo',
      note: 'Approved from submission photo queue'
    });
  } catch (err) {
    return json(500, { error: err.message || 'Failed to promote submission photo' });
  }

  const now = new Date().toISOString();
  const { response: patchResp, data: patchData } = await sbFetch(`submission_photos?submission_photo_id=eq.${encodeURIComponent(String(submissionPhotoId))}`, {
    method: 'PATCH',
    body: {
      status: 'approved',
      listing_id: listingId,
      reviewed_at: now,
      approved_at: now,
      notes: payload.notes ? String(payload.notes).slice(0, 400) : row.notes
    },
    prefer: 'return=representation'
  });

  if (!patchResp.ok) {
    return json(patchResp.status, {
      error: 'Listing photo published but failed to update submission photo status',
      details: patchData,
      listing: promoted.listing
    });
  }

  return json(200, {
    success: true,
    submission_photo: Array.isArray(patchData) ? patchData[0] : patchData,
    listing: promoted.listing
  });
}

async function rejectSubmissionPhoto(payload) {
  const submissionPhotoId = Number(payload.submission_photo_id);
  if (!Number.isFinite(submissionPhotoId) || submissionPhotoId <= 0) {
    return json(400, { error: 'submission_photo_id is required' });
  }

  const { response, data } = await sbFetch(`submission_photos?submission_photo_id=eq.${encodeURIComponent(String(submissionPhotoId))}`, {
    method: 'PATCH',
    body: {
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
      rejected_reason: String(payload.reason || 'Rejected by admin').slice(0, 400)
    },
    prefer: 'return=representation'
  });

  if (!response.ok) {
    return json(response.status, { error: 'Failed to reject submission photo', details: data });
  }

  return json(200, { success: true, submission_photo: Array.isArray(data) ? data[0] : data });
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const action = String(body.action || '').trim();

  try {
    if (action === 'estimate_coverage') return await estimateCoverage(body);
    if (action === 'queue_backfill') return await queueBackfill(body);
    if (action === 'list_jobs') return await listJobs(body);
    if (action === 'add_candidate') return await addPhotoCandidate(body);
    if (action === 'list_candidates') return await listCandidates(body);
    if (action === 'approve_candidate') return await setCandidateStatus(body, 'active');
    if (action === 'reject_candidate') return await setCandidateStatus(body, 'rejected');
    if (action === 'submit_submission_photo') return await submitSubmissionPhoto(body);
    if (action === 'list_submission_photos') return await listSubmissionPhotos(body);
    if (action === 'approve_submission_photo') return await approveSubmissionPhoto(body);
    if (action === 'reject_submission_photo') return await rejectSubmissionPhoto(body);

    return json(400, {
      error: 'Unsupported action',
      supported_actions: [
        'estimate_coverage',
        'queue_backfill',
        'list_jobs',
        'add_candidate',
        'list_candidates',
        'approve_candidate',
        'reject_candidate',
        'submit_submission_photo',
        'list_submission_photos',
        'approve_submission_photo',
        'reject_submission_photo'
      ]
    });
  } catch (err) {
    return json(500, { error: err && err.message ? err.message : 'Unexpected error' });
  }
};
