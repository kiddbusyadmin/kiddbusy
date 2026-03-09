const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const PHOTO_BUCKET = process.env.PHOTO_UPLOAD_BUCKET || 'listing-photos';
const PHOTO_UPLOAD_MAX_BYTES = Number(process.env.PHOTO_UPLOAD_MAX_BYTES || 6291456);
const CLAIM_CODE_TTL_MINUTES = Number(process.env.OWNER_CLAIM_CODE_TTL_MINUTES || 15);
const CLAIM_SESSION_DAYS = Number(process.env.OWNER_CLAIM_SESSION_DAYS || 30);
const EXPOSE_DEBUG_CODE = String(process.env.OWNER_CLAIM_EXPOSE_CODE || '').toLowerCase() === 'true';
const { sendCompliantEmail } = require('./_email-compliance');

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

function normalizeCity(city) {
  return String(city || '').split(',')[0].trim().toLowerCase();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function stripDataUriPrefix(base64) {
  const input = String(base64 || '').trim();
  const idx = input.indexOf(',');
  if (input.startsWith('data:') && idx !== -1) {
    return input.slice(idx + 1);
  }
  return input;
}

function extractDomainFromUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function extractDomainFromEmail(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 0) return '';
  return e.slice(at + 1).toLowerCase();
}

function isEmailDomainMatch(email, websiteUrl) {
  const emailDomain = extractDomainFromEmail(email);
  const siteDomain = extractDomainFromUrl(websiteUrl);
  if (!emailDomain || !siteDomain) return false;
  return emailDomain === siteDomain || emailDomain.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${emailDomain}`);
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
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

async function track(event, city = null, value = null, sessionId = null) {
  try {
    await sbFetch('analytics', {
      method: 'POST',
      body: {
        event,
        city,
        value,
        session_id: sessionId || null
      },
      prefer: 'return=minimal'
    });
  } catch {
    // non-blocking
  }
}

async function sendCodeEmail({ toEmail, businessName, code }) {
  if (!RESEND_API_KEY) {
    return { sent: false, reason: 'Resend not configured' };
  }

  const subject = `Your KiddBusy claim code for ${businessName}`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5">
  <h2 style="margin:0 0 10px">KiddBusy Business Claim</h2>
  <p>Use this verification code to continue claiming your listing:</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:14px 0">${code}</p>
  <p>This code expires in ${CLAIM_CODE_TTL_MINUTES} minutes.</p>
  <p>If you did not request this, you can ignore this email.</p>
  </div>`;

  try {
    const data = await sendCompliantEmail({
      to: toEmail,
      subject,
      body: html,
      fromName: 'KiddBusy',
      campaignType: 'owner_claim_verification',
      allowSuppressedBypass: true
    });
    return { sent: true, data };
  } catch (err) {
    return { sent: false, reason: 'Resend API error', details: err.message || String(err) };
  }
}

async function findListing(listingId) {
  const { response, data } = await sbFetch(`listings?select=listing_id,name,city,website,status,description,address&listing_id=eq.${encodeURIComponent(String(listingId))}&limit=1`);
  if (!response.ok || !Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

async function startClaim(payload) {
  const listingId = Number(payload.listing_id);
  const ownerEmail = normalizeEmail(payload.owner_email);
  const ownerName = String(payload.owner_name || '').trim() || null;
  const ownerPhone = String(payload.owner_phone || '').trim() || null;

  if (!Number.isFinite(listingId) || listingId <= 0) return json(400, { error: 'listing_id is required' });
  if (!ownerEmail || !ownerEmail.includes('@')) return json(400, { error: 'Valid owner_email is required' });

  const listing = await findListing(listingId);
  if (!listing || listing.status !== 'active') {
    return json(404, { error: 'Listing not found or inactive' });
  }

  const code = generateSixDigitCode();
  const now = new Date();
  const expires = new Date(now.getTime() + CLAIM_CODE_TTL_MINUTES * 60 * 1000).toISOString();

  const { response: insertResp, data: claimRows } = await sbFetch('owner_claims', {
    method: 'POST',
    body: {
      listing_id: listingId,
      owner_name: ownerName,
      owner_email: ownerEmail,
      owner_phone: ownerPhone,
      status: 'code_sent',
      verification_code: code,
      code_expires_at: expires,
      verify_attempts: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    },
    prefer: 'return=representation'
  });

  if (!insertResp.ok) {
    return json(insertResp.status, { error: 'Failed to create claim request', details: claimRows });
  }

  const claim = Array.isArray(claimRows) ? claimRows[0] : null;
  const emailResult = await sendCodeEmail({ toEmail: ownerEmail, businessName: listing.name, code });

  await track('owner_claim_start', listing.city, String(listingId));
  await track(emailResult.sent ? 'owner_claim_code_sent' : 'owner_claim_code_send_failed', listing.city, emailResult.sent ? 'ok' : 'failed');

  return json(200, {
    success: true,
    claim_id: claim ? claim.claim_id : null,
    expires_at: expires,
    email_sent: emailResult.sent,
    email_note: emailResult.sent ? 'Verification code sent' : 'Code generated but email delivery failed',
    ...(EXPOSE_DEBUG_CODE ? { debug_code: code } : {})
  });
}

async function verifyClaim(payload) {
  const claimId = Number(payload.claim_id);
  const ownerEmail = normalizeEmail(payload.owner_email);
  const code = String(payload.code || '').trim();

  if (!Number.isFinite(claimId) || claimId <= 0) return json(400, { error: 'claim_id is required' });
  if (!ownerEmail || !ownerEmail.includes('@')) return json(400, { error: 'owner_email is required' });
  if (!code) return json(400, { error: 'code is required' });

  const { response: claimResp, data: claimRows } = await sbFetch(`owner_claims?select=*&claim_id=eq.${encodeURIComponent(String(claimId))}&owner_email=eq.${encodeURIComponent(ownerEmail)}&limit=1`);
  if (!claimResp.ok) return json(claimResp.status, { error: 'Failed to read claim', details: claimRows });
  if (!Array.isArray(claimRows) || claimRows.length === 0) return json(404, { error: 'Claim not found' });

  const claim = claimRows[0];
  const listing = await findListing(claim.listing_id);
  if (!listing) return json(404, { error: 'Listing no longer available' });

  const now = new Date();
  const nowIso = now.toISOString();
  const expired = !claim.code_expires_at || new Date(claim.code_expires_at).getTime() < now.getTime();

  await track('owner_claim_verify_attempt', listing.city, String(claim.claim_id));

  if (expired) {
    await sbFetch(`owner_claims?claim_id=eq.${encodeURIComponent(String(claim.claim_id))}`, {
      method: 'PATCH',
      body: { status: 'expired', updated_at: nowIso },
      prefer: 'return=minimal'
    });
    await track('owner_claim_failed', listing.city, 'expired');
    return json(410, { error: 'Verification code expired. Start a new claim request.' });
  }

  const attempts = Number(claim.verify_attempts || 0);
  if (attempts >= 5) {
    await track('owner_claim_failed', listing.city, 'max_attempts');
    return json(429, { error: 'Too many attempts. Start a new claim request.' });
  }

  if (String(claim.verification_code || '') !== code) {
    await sbFetch(`owner_claims?claim_id=eq.${encodeURIComponent(String(claim.claim_id))}`, {
      method: 'PATCH',
      body: { verify_attempts: attempts + 1, last_attempt_at: nowIso, updated_at: nowIso },
      prefer: 'return=minimal'
    });
    await track('owner_claim_failed', listing.city, 'bad_code');
    return json(401, { error: 'Invalid verification code' });
  }

  const autoApprove = isEmailDomainMatch(ownerEmail, listing.website);
  const status = autoApprove ? 'approved' : 'pending_review';
  const sessionToken = crypto.randomUUID();
  const sessionExpiresAt = new Date(now.getTime() + CLAIM_SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const patchPayload = {
    status,
    verified_at: nowIso,
    approved_at: autoApprove ? nowIso : null,
    session_token: sessionToken,
    session_expires_at: sessionExpiresAt,
    updated_at: nowIso
  };

  const { response: patchResp, data: patchedClaim } = await sbFetch(`owner_claims?claim_id=eq.${encodeURIComponent(String(claim.claim_id))}`, {
    method: 'PATCH',
    body: patchPayload,
    prefer: 'return=representation'
  });
  if (!patchResp.ok) return json(patchResp.status, { error: 'Failed to verify claim', details: patchedClaim });

  if (autoApprove) {
    await sbFetch('listing_owners?on_conflict=listing_id,owner_email', {
      method: 'POST',
      body: {
        listing_id: claim.listing_id,
        claim_id: claim.claim_id,
        owner_name: claim.owner_name,
        owner_email: claim.owner_email,
        status: 'active',
        updated_at: nowIso
      },
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
  }

  await track('owner_claim_verified', listing.city, autoApprove ? 'approved' : 'pending_review');

  return json(200, {
    success: true,
    approved: autoApprove,
    pending_review: !autoApprove,
    status,
    session_token: sessionToken,
    session_expires_at: sessionExpiresAt,
    listing: {
      listing_id: listing.listing_id,
      name: listing.name,
      city: listing.city
    }
  });
}

async function getSession(payload) {
  const sessionToken = String(payload.session_token || '').trim();
  if (!sessionToken) return json(400, { error: 'session_token is required' });

  const { response: claimResp, data: rows } = await sbFetch(`owner_claims?select=*&session_token=eq.${encodeURIComponent(sessionToken)}&limit=1`);
  if (!claimResp.ok) return json(claimResp.status, { error: 'Failed to load claim session', details: rows });
  if (!Array.isArray(rows) || rows.length === 0) return json(404, { error: 'Session not found' });

  const claim = rows[0];
  const now = Date.now();
  if (!claim.session_expires_at || new Date(claim.session_expires_at).getTime() < now) {
    return json(401, { error: 'Session expired' });
  }

  const listing = await findListing(claim.listing_id);
  if (!listing) return json(404, { error: 'Listing not found' });

  await track('owner_dashboard_open', listing.city, String(listing.listing_id));

  return json(200, {
    success: true,
    claim: {
      claim_id: claim.claim_id,
      status: claim.status,
      owner_email: claim.owner_email,
      owner_name: claim.owner_name,
      session_expires_at: claim.session_expires_at
    },
    listing
  });
}

async function submitUpdate(payload) {
  const sessionToken = String(payload.session_token || '').trim();
  if (!sessionToken) return json(400, { error: 'session_token is required' });

  const { response: claimResp, data: claimRows } = await sbFetch(`owner_claims?select=*&session_token=eq.${encodeURIComponent(sessionToken)}&limit=1`);
  if (!claimResp.ok) return json(claimResp.status, { error: 'Failed to load claim session', details: claimRows });
  if (!Array.isArray(claimRows) || claimRows.length === 0) return json(404, { error: 'Session not found' });

  const claim = claimRows[0];
  if (claim.status !== 'approved') {
    return json(403, { error: 'Listing claim is not approved yet' });
  }

  if (!claim.session_expires_at || new Date(claim.session_expires_at).getTime() < Date.now()) {
    return json(401, { error: 'Session expired' });
  }

  const listing = await findListing(claim.listing_id);
  if (!listing) return json(404, { error: 'Listing not found' });

  const description = payload.description != null ? String(payload.description).trim() : null;
  const address = payload.address != null ? String(payload.address).trim() : null;
  const website = payload.website != null ? String(payload.website).trim() : null;

  const updateFields = {};
  if (description) updateFields.description = description;
  if (address) updateFields.address = address;
  if (website) updateFields.website = website;

  const nowIso = new Date().toISOString();
  const createdRequests = [];

  if (Object.keys(updateFields).length > 0) {
    const listingPatch = await sbFetch(`listings?listing_id=eq.${encodeURIComponent(String(claim.listing_id))}`, {
      method: 'PATCH',
      body: updateFields,
      prefer: 'return=representation'
    });
    if (!listingPatch.response.ok) {
      return json(listingPatch.response.status, { error: 'Failed to update listing fields', details: listingPatch.data });
    }

    const req = await sbFetch('owner_change_requests', {
      method: 'POST',
      body: {
        listing_id: claim.listing_id,
        claim_id: claim.claim_id,
        owner_email: claim.owner_email,
        change_type: 'listing_fields',
        payload: updateFields,
        status: 'auto_approved',
        review_notes: 'Auto-approved owner edit',
        reviewed_at: nowIso
      },
      prefer: 'return=representation'
    });
    if (req.response.ok && Array.isArray(req.data) && req.data[0]) createdRequests.push(req.data[0]);
  }

  let uploadedPhotoUrl = null;

  if (payload.file_base64) {
    const base64Raw = stripDataUriPrefix(payload.file_base64);
    const bytes = Buffer.from(base64Raw, 'base64');
    if (!bytes || !bytes.length) return json(400, { error: 'Invalid file_base64 payload' });
    if (bytes.length > PHOTO_UPLOAD_MAX_BYTES) return json(413, { error: `Image too large. Max bytes: ${PHOTO_UPLOAD_MAX_BYTES}` });

    const fileName = String(payload.file_name || 'owner-upload.jpg').slice(0, 160);
    const ext = (fileName.toLowerCase().split('.').pop() || 'jpg').replace(/[^a-z0-9]/g, '').slice(0, 8) || 'jpg';
    const path = `owners/${cleanSegment(listing.city)}/${cleanSegment(listing.name)}/${Date.now()}-${Math.floor(Math.random() * 100000)}.${ext}`;

    const upload = await uploadBinaryToStorage(path, bytes, String(payload.mime_type || 'image/jpeg').slice(0, 80));
    if (!upload.response.ok) {
      return json(upload.response.status, { error: `Photo upload failed for bucket '${PHOTO_BUCKET}'`, details: upload.data });
    }

    uploadedPhotoUrl = `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;

    await sbFetch(`listing_photos?listing_id=eq.${encodeURIComponent(String(claim.listing_id))}&status=eq.active`, {
      method: 'PATCH',
      body: { status: 'superseded', reviewed_at: nowIso },
      prefer: 'return=minimal'
    });

    const photoCandidate = await sbFetch('listing_photos?on_conflict=listing_id,source_url', {
      method: 'POST',
      body: {
        listing_id: claim.listing_id,
        provider: 'owner_portal',
        source_url: uploadedPhotoUrl,
        cdn_url: uploadedPhotoUrl,
        status: 'active',
        reviewed_at: nowIso,
        approved_at: nowIso,
        raw_payload: { source: 'owner_portal' }
      },
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
    if (!photoCandidate.response.ok) {
      return json(photoCandidate.response.status, { error: 'Failed to record listing photo', details: photoCandidate.data });
    }

    const listingPhotoPatch = await sbFetch(`listings?listing_id=eq.${encodeURIComponent(String(claim.listing_id))}`, {
      method: 'PATCH',
      body: {
        photo_url: uploadedPhotoUrl,
        photo_source: 'owner_portal',
        photo_status: 'active',
        photo_updated_at: nowIso
      },
      prefer: 'return=minimal'
    });
    if (!listingPhotoPatch.response.ok) {
      return json(listingPhotoPatch.response.status, { error: 'Failed to apply approved owner photo to listing', details: listingPhotoPatch.data });
    }

    const reqPhoto = await sbFetch('owner_change_requests', {
      method: 'POST',
      body: {
        listing_id: claim.listing_id,
        claim_id: claim.claim_id,
        owner_email: claim.owner_email,
        change_type: 'photo',
        payload: { photo_url: uploadedPhotoUrl },
        status: 'auto_approved',
        review_notes: 'Auto-approved owner photo upload',
        reviewed_at: nowIso
      },
      prefer: 'return=representation'
    });
    if (reqPhoto.response.ok && Array.isArray(reqPhoto.data) && reqPhoto.data[0]) createdRequests.push(reqPhoto.data[0]);
  }

  await track('owner_update_submit', listing.city, String(claim.listing_id));
  await track('owner_update_auto_approved', listing.city, String(createdRequests.length));

  return json(200, {
    success: true,
    listing_id: claim.listing_id,
    updated_fields: Object.keys(updateFields),
    photo_updated: !!uploadedPhotoUrl,
    photo_url: uploadedPhotoUrl,
    change_requests: createdRequests
  });
}

async function abandonClaim(payload) {
  const claimId = Number(payload.claim_id);
  const city = String(payload.city || '').trim() || null;
  const reason = String(payload.reason || 'abandon').slice(0, 120);

  if (Number.isFinite(claimId) && claimId > 0) {
    await sbFetch(`owner_claims?claim_id=eq.${encodeURIComponent(String(claimId))}&status=eq.code_sent`, {
      method: 'PATCH',
      body: { status: 'abandoned', updated_at: new Date().toISOString() },
      prefer: 'return=minimal'
    });
  }

  await track('owner_claim_abandon', city, reason);
  return json(200, { success: true });
}

async function logOwnerEvent(payload) {
  const event = String(payload.event || '').trim();
  if (!event) return json(400, { error: 'event is required' });
  const city = payload.city ? String(payload.city).trim() : null;
  const value = payload.value ? String(payload.value).slice(0, 200) : null;
  const sessionId = payload.session_id ? String(payload.session_id).slice(0, 120) : null;
  await track(event, city, value, sessionId);
  return json(200, { success: true });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!['kiddbusy-owner', 'kiddbusy-hq'].includes(source)) {
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
    if (action === 'start_claim') return await startClaim(body);
    if (action === 'verify_claim') return await verifyClaim(body);
    if (action === 'get_session') return await getSession(body);
    if (action === 'submit_update') return await submitUpdate(body);
    if (action === 'abandon_claim') return await abandonClaim(body);
    if (action === 'log_event') return await logOwnerEvent(body);

    return json(400, {
      error: 'Unsupported action',
      supported_actions: ['start_claim', 'verify_claim', 'get_session', 'submit_update', 'abandon_claim', 'log_event']
    });
  } catch (err) {
    return json(500, { error: err && err.message ? err.message : 'Unexpected error' });
  }
};
