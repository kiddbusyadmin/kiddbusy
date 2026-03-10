const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';
const PHOTO_BUCKET = process.env.PHOTO_UPLOAD_BUCKET || 'listing-photos';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function cleanSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function safeText(value, max) {
  return String(value || '').trim().slice(0, max || 200);
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

async function uploadBinaryToStorage(path, bytes, mimeType) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType || 'image/png',
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

async function findListing(listingId) {
  const { response, data } = await sbFetch(
    `listings?select=listing_id,name,city,state,category,address,description,status&listing_id=eq.${encodeURIComponent(String(listingId))}&limit=1`
  );
  if (!response.ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

function defaultPromptForListing(listing) {
  const name = safeText(listing.name, 160);
  const city = safeText(listing.city, 100);
  const category = safeText(listing.category, 120);
  const address = safeText(listing.address, 180);
  const desc = safeText(listing.description, 500);
  return [
    'Create a bright, family-friendly, photorealistic exterior image of this real business location.',
    'No text overlay, no logos, no watermarks, no people close-up, no copyrighted characters.',
    'Natural daylight, clean composition, safe and welcoming vibe.',
    `Business: ${name}`,
    `Category: ${category || 'Family activity location'}`,
    `City: ${city}`,
    `Address context: ${address || 'Unknown address'}`,
    desc ? `Description context: ${desc}` : ''
  ].filter(Boolean).join('\n');
}

async function callOpenAiImage(prompt, options) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: options.model || OPENAI_IMAGE_MODEL,
      prompt,
      size: options.size || OPENAI_IMAGE_SIZE,
      quality: options.quality || OPENAI_IMAGE_QUALITY
    })
  });
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : 'OpenAI image generation failed';
    throw new Error(message);
  }
  const item = data && Array.isArray(data.data) && data.data.length ? data.data[0] : null;
  if (!item) throw new Error('OpenAI returned no image payload');
  if (item.b64_json) {
    return {
      bytes: Buffer.from(String(item.b64_json), 'base64'),
      mimeType: 'image/png'
    };
  }
  if (item.url) {
    const dl = await fetch(String(item.url));
    if (!dl.ok) throw new Error('Failed to download generated image URL');
    return {
      bytes: Buffer.from(await dl.arrayBuffer()),
      mimeType: dl.headers.get('content-type') || 'image/png'
    };
  }
  throw new Error('OpenAI response missing b64_json/url');
}

async function promoteListingPhoto({ listingId, photoUrl, promptText }) {
  const now = new Date().toISOString();
  await sbFetch(`listing_photos?listing_id=eq.${encodeURIComponent(String(listingId))}&status=eq.active`, {
    method: 'PATCH',
    body: { status: 'superseded', reviewed_at: now },
    prefer: 'return=minimal'
  });

  const photoRow = {
    listing_id: listingId,
    provider: 'openai_image',
    source_url: photoUrl,
    cdn_url: photoUrl,
    status: 'active',
    reviewed_at: now,
    approved_at: now,
    raw_payload: { prompt: safeText(promptText, 1200), source: 'image-generate' }
  };
  const photoIns = await sbFetch('listing_photos?on_conflict=listing_id,source_url', {
    method: 'POST',
    body: photoRow,
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!photoIns.response.ok) {
    throw new Error('Failed to insert listing photo');
  }

  const listingPatch = await sbFetch(`listings?listing_id=eq.${encodeURIComponent(String(listingId))}`, {
    method: 'PATCH',
    body: {
      photo_url: photoUrl,
      photo_source: 'openai_image',
      photo_status: 'active',
      photo_updated_at: now
    },
    prefer: 'return=representation'
  });
  if (!listingPatch.response.ok) {
    throw new Error('Failed to update listing with generated photo');
  }
  return {
    listing: Array.isArray(listingPatch.data) ? listingPatch.data[0] : null,
    photo: Array.isArray(photoIns.data) ? photoIns.data[0] : null
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!['kiddbusy-hq', 'kiddbusy-agent'].includes(source)) {
    return json(403, { error: 'Forbidden' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }
  if (!OPENAI_API_KEY) {
    return json(500, { error: 'OPENAI_API_KEY missing' });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const listingId = Number(body.listing_id);
  if (!Number.isFinite(listingId) || listingId <= 0) {
    return json(400, { error: 'listing_id is required' });
  }

  const listing = await findListing(listingId);
  if (!listing || String(listing.status || '').toLowerCase() !== 'active') {
    return json(404, { error: 'Active listing not found' });
  }

  try {
    const prompt = safeText(body.prompt, 4000) || defaultPromptForListing(listing);
    const image = await callOpenAiImage(prompt, {
      model: safeText(body.model, 80) || OPENAI_IMAGE_MODEL,
      size: safeText(body.size, 30) || OPENAI_IMAGE_SIZE,
      quality: safeText(body.quality, 30) || OPENAI_IMAGE_QUALITY
    });

    const ext = (image.mimeType || '').includes('webp') ? 'webp' : ((image.mimeType || '').includes('jpeg') ? 'jpg' : 'png');
    const path = `ai-generated/${cleanSegment(listing.city)}/${cleanSegment(listing.name)}/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;
    const upload = await uploadBinaryToStorage(path, image.bytes, image.mimeType);
    if (!upload.response.ok) {
      return json(upload.response.status, { error: 'Failed to upload generated image to storage', details: upload.data });
    }

    const photoUrl = `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
    const promoted = await promoteListingPhoto({ listingId, photoUrl, promptText: prompt });

    return json(200, {
      success: true,
      listing_id: listingId,
      prompt_used: prompt,
      model_used: safeText(body.model, 80) || OPENAI_IMAGE_MODEL,
      uploaded_url: photoUrl,
      listing: promoted.listing,
      photo: promoted.photo
    });
  } catch (err) {
    return json(500, { error: err.message || 'Image generation failed' });
  }
};
