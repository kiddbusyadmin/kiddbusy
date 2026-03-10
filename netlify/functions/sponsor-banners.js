const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const BANNER_BUCKET = process.env.SPONSOR_BANNER_BUCKET || 'sponsor-banners';
const BANNER_MAX_BYTES = Number(process.env.SPONSOR_BANNER_MAX_BYTES || 6291456);

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
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BANNER_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
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

function requiresAdmin(action) {
  return action !== 'get_active_banner';
}

function isTruthy(v) {
  return String(v || '').toLowerCase() === 'true' || v === true;
}

async function listBanners(payload) {
  const limit = Math.min(Math.max(Number(payload.limit) || 200, 1), 1000);
  const status = String(payload.status || '').trim();
  const city = String(payload.city || '').trim();

  const filters = ['select=*', 'order=created_at.desc', `limit=${limit}`];
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);

  const { response, data } = await sbFetch(`sponsor_banners?${filters.join('&')}`);
  if (!response.ok) {
    return json(response.status, { error: 'Failed to query sponsor banners', details: data });
  }

  let rows = Array.isArray(data) ? data : [];
  if (city) {
    const cityNorm = normalizeCity(city);
    rows = rows.filter((r) => normalizeCity(r.city) === cityNorm);
  }

  return json(200, { count: rows.length, banners: rows });
}

async function isSponsorshipActive(sponsorshipId) {
  const id = String(sponsorshipId || '').trim();
  if (!id) return true;
  const { response, data } = await sbFetch(`sponsorships?id=eq.${encodeURIComponent(id)}&select=id,status&limit=1`);
  if (!response.ok || !Array.isArray(data) || data.length === 0) return false;
  return String(data[0].status || '').toLowerCase() === 'active';
}

async function getActiveBanner(payload) {
  const city = String(payload.city || '').trim();
  if (!city) return json(400, { error: 'city is required' });

  const cityNorm = normalizeCity(city);
  const { response, data } = await sbFetch('sponsor_banners?select=*&status=eq.approved&order=priority.asc,approved_at.desc,created_at.desc&limit=300');
  if (!response.ok) {
    return json(response.status, { error: 'Failed to query approved banners', details: data });
  }

  const rows = (Array.isArray(data) ? data : []).filter((r) => normalizeCity(r.city) === cityNorm);
  for (const row of rows) {
    const active = await isSponsorshipActive(row.sponsorship_id);
    if (!active) continue;
    return json(200, {
      found: true,
      banner: {
        banner_id: row.banner_id,
        city: row.city,
        business_name: row.business_name,
        image_url: row.image_url,
        click_url: row.click_url,
        headline: row.headline,
        subheadline: row.subheadline,
        sponsorship_id: row.sponsorship_id,
        listing_id: row.listing_id
      }
    });
  }

  return json(200, { found: false, banner: null });
}

async function submitBanner(payload) {
  const city = String(payload.city || '').trim();
  const businessName = String(payload.business_name || '').trim();
  const submitterEmail = String(payload.submitted_by_email || '').trim();
  const submitterName = String(payload.submitted_by_name || '').trim();
  const imageUrlInput = String(payload.image_url || '').trim();

  if (!city) return json(400, { error: 'city is required' });
  if (!businessName) return json(400, { error: 'business_name is required' });

  let imageUrl = imageUrlInput;
  let mimeType = String(payload.mime_type || 'image/jpeg').slice(0, 80);
  let fileSizeBytes = null;

  if (!imageUrl) {
    const fileBase64 = stripDataUriPrefix(payload.file_base64);
    if (!fileBase64) {
      return json(400, { error: 'Provide either image_url or file_base64' });
    }

    const bytes = Buffer.from(fileBase64, 'base64');
    if (!bytes || !bytes.length) {
      return json(400, { error: 'Invalid image payload' });
    }
    if (bytes.length > BANNER_MAX_BYTES) {
      return json(413, { error: `Image too large. Max bytes: ${BANNER_MAX_BYTES}` });
    }

    fileSizeBytes = bytes.length;
    const fileName = String(payload.file_name || 'banner.jpg').slice(0, 160);
    const ext = (fileName.toLowerCase().split('.').pop() || 'jpg').replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg';
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const path = `${cleanSegment(city)}/${cleanSegment(businessName)}/${yyyy}/${mm}/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;

    const upload = await uploadBinaryToStorage(path, bytes, mimeType);
    if (!upload.response.ok) {
      return json(upload.response.status, {
        error: `Failed to upload banner image to storage bucket '${BANNER_BUCKET}'`,
        details: upload.data
      });
    }

    imageUrl = `${SUPABASE_URL}/storage/v1/object/public/${BANNER_BUCKET}/${path}`;
  }

  const clickUrl = String(payload.click_url || '').trim();
  const row = {
    sponsorship_id: payload.sponsorship_id != null ? String(payload.sponsorship_id) : null,
    listing_id: Number(payload.listing_id) > 0 ? Number(payload.listing_id) : null,
    city,
    business_name: businessName,
    image_url: imageUrl,
    click_url: clickUrl || null,
    headline: payload.headline ? String(payload.headline).slice(0, 120) : null,
    subheadline: payload.subheadline ? String(payload.subheadline).slice(0, 220) : null,
    priority: Number.isFinite(Number(payload.priority)) ? Math.max(1, Math.min(1000, Number(payload.priority))) : 100,
    source: String(payload.source || 'admin_upload').slice(0, 80),
    mime_type: mimeType || null,
    file_size_bytes: fileSizeBytes,
    status: isTruthy(payload.auto_approve) ? 'approved' : 'pending',
    submitted_by_name: submitterName || null,
    submitted_by_email: submitterEmail || null,
    notes: payload.notes ? String(payload.notes).slice(0, 400) : null,
    reviewed_at: isTruthy(payload.auto_approve) ? new Date().toISOString() : null,
    approved_at: isTruthy(payload.auto_approve) ? new Date().toISOString() : null
  };

  const { response, data } = await sbFetch('sponsor_banners', {
    method: 'POST',
    body: row,
    prefer: 'return=representation'
  });

  if (!response.ok) {
    return json(response.status, { error: 'Failed to save sponsor banner row', details: data });
  }

  return json(200, {
    success: true,
    banner: Array.isArray(data) ? data[0] : data
  });
}

async function approveBanner(payload) {
  const bannerId = Number(payload.banner_id);
  if (!Number.isFinite(bannerId) || bannerId <= 0) return json(400, { error: 'banner_id is required' });

  const status = isTruthy(payload.archive) ? 'archived' : 'approved';
  const now = new Date().toISOString();
  const updates = {
    status,
    reviewed_at: now,
    approved_at: status === 'approved' ? now : null,
    rejected_reason: null,
    notes: payload.notes ? String(payload.notes).slice(0, 400) : null
  };

  const { response, data } = await sbFetch(`sponsor_banners?banner_id=eq.${encodeURIComponent(String(bannerId))}`, {
    method: 'PATCH',
    body: updates,
    prefer: 'return=representation'
  });

  if (!response.ok) return json(response.status, { error: 'Failed to update banner status', details: data });
  return json(200, { success: true, banner: Array.isArray(data) ? data[0] : data });
}

async function rejectBanner(payload) {
  const bannerId = Number(payload.banner_id);
  if (!Number.isFinite(bannerId) || bannerId <= 0) return json(400, { error: 'banner_id is required' });

  const now = new Date().toISOString();
  const updates = {
    status: 'rejected',
    reviewed_at: now,
    approved_at: null,
    rejected_reason: String(payload.reason || 'Rejected by admin').slice(0, 400)
  };

  const { response, data } = await sbFetch(`sponsor_banners?banner_id=eq.${encodeURIComponent(String(bannerId))}`, {
    method: 'PATCH',
    body: updates,
    prefer: 'return=representation'
  });

  if (!response.ok) return json(response.status, { error: 'Failed to reject banner', details: data });
  return json(200, { success: true, banner: Array.isArray(data) ? data[0] : data });
}

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let payload = {};
  if (event.httpMethod === 'GET') {
    payload = event.queryStringParameters || {};
  } else {
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
  }

  const action = String(payload.action || '').trim() || 'get_active_banner';
  if (requiresAdmin(action)) {
    const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
    if (source !== 'kiddbusy-hq') {
      return json(403, { error: 'Forbidden' });
    }
  }

  try {
    if (action === 'get_active_banner') return await getActiveBanner(payload);
    if (action === 'list_banners') return await listBanners(payload);
    if (action === 'submit_banner') return await submitBanner(payload);
    if (action === 'approve_banner') return await approveBanner(payload);
    if (action === 'reject_banner') return await rejectBanner(payload);

    return json(400, {
      error: 'Unsupported action',
      supported_actions: ['get_active_banner', 'list_banners', 'submit_banner', 'approve_banner', 'reject_banner']
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
