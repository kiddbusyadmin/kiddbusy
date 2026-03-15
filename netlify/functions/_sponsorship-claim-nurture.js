const { sendCompliantEmail } = require('./_email-compliance');
const { verifySponsorshipOwnerClaim } = require('./_sponsorship-payment-email');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://kiddbusy.com';
const NURTURE_STEPS_HOURS = [0, 24, 72, 168];

function nowIso() {
  return new Date().toISOString();
}

function parseListingId(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const id = Math.floor(n);
  return id > 0 ? id : null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

async function sbFetch(path, options) {
  const opts = options || {};
  const method = opts.method || 'GET';
  const body = Object.prototype.hasOwnProperty.call(opts, 'body') ? opts.body : null;
  const prefer = opts.prefer || null;
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
  } catch (_) {
    data = text;
  }
  return { response: response, data: data };
}

function claimUrlFor(sponsorship) {
  const row = sponsorship || {};
  const listingId = parseListingId(row.listing_id);
  if (!listingId) return `${APP_BASE_URL.replace(/\/$/, '')}/owner.html`;
  const qs = new URLSearchParams({
    listing_id: String(listingId),
    listing_name: String(row.business_name || ''),
    city: String(row.city || '')
  });
  return `${APP_BASE_URL.replace(/\/$/, '')}/owner.html?${qs.toString()}`;
}

function buildEmail({ sponsorship, step }) {
  const row = sponsorship || {};
  const business = String(row.business_name || 'your business').trim();
  const city = String(row.city || '').trim();
  const first = String(row.first_name || '').trim();
  const greet = first ? `Hi ${first},` : 'Hi there,';
  const url = claimUrlFor(row);
  const attempt = Number(step || 0) + 1;
  const subject = attempt === 1
    ? `Action needed: claim ${business} on KiddBusy to activate sponsorship`
    : `Reminder: claim ${business} to unlock your KiddBusy sponsorship`;

  const html = [
    '<div style="margin:0;padding:0;background:#f6f3ff;font-family:Arial,Helvetica,sans-serif;color:#241f38">',
    '<div style="max-width:620px;margin:0 auto;padding:24px 16px">',
    '<div style="background:#fff;border:1px solid #e8ddff;border-radius:14px;overflow:hidden">',
    '<div style="padding:16px 18px;background:linear-gradient(90deg,#bfa6ff,#8fd9ff)">',
    '<div style="font-size:20px;font-weight:700;color:#1f143f">KiddBusy Sponsorship Activation</div>',
    '</div>',
    '<div style="padding:18px">',
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">${greet}</p>`,
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">Before we can activate sponsorship for <strong>${business}</strong>${city ? ` in <strong>${city}</strong>` : ''}, we need you to claim and verify this listing.</p>`,
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.55">This protects business owners and prevents unauthorized ad purchases.</p>',
    `<a href="${url}" style="display:inline-block;background:#5f38e6;color:#fff;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:10px">Claim & Verify Listing</a>`,
    '<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#574f72">Once verified, we will immediately send your secure Stripe activation link.</p>',
    '</div></div></div></div>'
  ].join('');

  return { subject: subject, html: html, claim_url: url };
}

async function enrollClaimNurture({ sponsorship, reason = 'owner_claim_required', source = 'db_proxy' }) {
  const row = sponsorship || {};
  const sponsorshipId = String(row.id || '').trim();
  const ownerEmail = normalizeEmail(row.email);
  if (!sponsorshipId || !ownerEmail || ownerEmail.indexOf('@') < 0) {
    return { enrolled: false, reason: 'missing_sponsorship_id_or_email' };
  }
  const payload = {
    sponsorship_id: sponsorshipId,
    listing_id: parseListingId(row.listing_id),
    owner_email: ownerEmail,
    business_name: String(row.business_name || '').trim() || null,
    city: String(row.city || '').trim() || null,
    status: 'active',
    block_reason: String(reason || 'owner_claim_required').slice(0, 120),
    source: String(source || 'db_proxy').slice(0, 80),
    next_send_at: nowIso(),
    updated_at: nowIso(),
    resolved_reason: null,
    resolved_at: null,
    last_error: null
  };
  const out = await sbFetch('sponsorship_claim_nurture?on_conflict=sponsorship_id,owner_email', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: payload
  });
  if (!out.response.ok) {
    return { enrolled: false, reason: 'upsert_failed', details: out.data };
  }
  const saved = Array.isArray(out.data) && out.data[0] ? out.data[0] : null;
  return { enrolled: true, row: saved };
}

async function loadDueRows(limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const q = `sponsorship_claim_nurture?select=*&status=eq.active&next_send_at=lte.${encodeURIComponent(nowIso())}&order=next_send_at.asc&limit=${safeLimit}`;
  const out = await sbFetch(q);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function getSponsorshipById(id) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  const out = await sbFetch(`sponsorships?id=eq.${encodeURIComponent(sid)}&select=*&limit=1`);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function updateNurture(nurtureId, patch) {
  return sbFetch(`sponsorship_claim_nurture?nurture_id=eq.${encodeURIComponent(String(nurtureId))}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: Object.assign({}, patch, { updated_at: nowIso() })
  });
}

function nextSendAtForStep(step) {
  const idx = Math.max(0, Math.floor(Number(step) || 0));
  if (idx >= NURTURE_STEPS_HOURS.length) return null;
  const hours = NURTURE_STEPS_HOURS[idx];
  return new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString();
}

async function processClaimNurture({ limit = 120, dryRun = false } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase configuration missing');
  }
  const due = await loadDueRows(limit);
  const results = [];
  let sent = 0;
  let completed = 0;
  let stopped = 0;
  let errors = 0;

  for (let i = 0; i < due.length; i += 1) {
    const row = due[i] || {};
    const sponsorship = await getSponsorshipById(row.sponsorship_id);
    if (!sponsorship) {
      await updateNurture(row.nurture_id, { status: 'stopped', resolved_reason: 'sponsorship_missing', resolved_at: nowIso() });
      stopped += 1;
      results.push({ nurture_id: row.nurture_id, status: 'stopped', reason: 'sponsorship_missing' });
      continue;
    }

    const claimCheck = await verifySponsorshipOwnerClaim(sponsorship);
    if (claimCheck && claimCheck.ok) {
      await updateNurture(row.nurture_id, { status: 'completed', resolved_reason: 'owner_claim_verified', resolved_at: nowIso() });
      completed += 1;
      results.push({ nurture_id: row.nurture_id, status: 'completed', reason: 'owner_claim_verified' });
      continue;
    }

    const currentStep = Math.max(0, Math.floor(Number(row.step) || 0));
    if (currentStep >= NURTURE_STEPS_HOURS.length) {
      await updateNurture(row.nurture_id, { status: 'stopped', resolved_reason: 'max_followups_sent', resolved_at: nowIso() });
      stopped += 1;
      results.push({ nurture_id: row.nurture_id, status: 'stopped', reason: 'max_followups_sent' });
      continue;
    }

    const email = buildEmail({ sponsorship: sponsorship, step: currentStep });
    if (dryRun) {
      const nextAt = nextSendAtForStep(currentStep + 1);
      await updateNurture(row.nurture_id, {
        step: currentStep + 1,
        send_count: Number(row.send_count || 0) + 1,
        last_sent_at: nowIso(),
        next_send_at: nextAt || nowIso(),
        status: nextAt ? 'active' : 'stopped',
        resolved_reason: nextAt ? null : 'max_followups_sent',
        resolved_at: nextAt ? null : nowIso(),
        last_error: null
      });
      results.push({ nurture_id: row.nurture_id, status: 'dry_run_sent', step: currentStep, claim_url: email.claim_url });
      sent += 1;
      continue;
    }

    try {
      const sendResult = await sendCompliantEmail({
        to: sponsorship.email,
        subject: email.subject,
        body: email.html,
        fromName: 'KiddBusy Team',
        campaignType: 'owner_claim_nurture_blocked_sponsorship'
      });
      const nextAt = nextSendAtForStep(currentStep + 1);
      await updateNurture(row.nurture_id, {
        step: currentStep + 1,
        send_count: Number(row.send_count || 0) + 1,
        last_sent_at: nowIso(),
        next_send_at: nextAt || nowIso(),
        status: nextAt ? 'active' : 'stopped',
        resolved_reason: nextAt ? null : 'max_followups_sent',
        resolved_at: nextAt ? null : nowIso(),
        last_error: null
      });
      sent += 1;
      results.push({
        nurture_id: row.nurture_id,
        status: sendResult && sendResult.suppressed ? 'suppressed' : 'sent',
        step: currentStep,
        claim_url: email.claim_url
      });
    } catch (err) {
      await updateNurture(row.nurture_id, { status: 'error', last_error: String(err.message || err).slice(0, 800) });
      errors += 1;
      results.push({ nurture_id: row.nurture_id, status: 'error', error: String(err.message || err) });
    }
  }

  return {
    success: true,
    scanned: due.length,
    sent: sent,
    completed: completed,
    stopped: stopped,
    errors: errors,
    results: results
  };
}

module.exports = {
  json,
  enrollClaimNurture,
  processClaimNurture
};
