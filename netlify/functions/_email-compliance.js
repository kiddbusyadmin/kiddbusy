const crypto = require('crypto');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'admin@kiddbusy.com';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://kiddbusy.com';
const EMAIL_UNSUBSCRIBE_SECRET = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'kiddbusy-unsub-secret';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(input) {
  const v = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = v.length % 4 === 0 ? '' : '='.repeat(4 - (v.length % 4));
  return Buffer.from(v + pad, 'base64').toString('utf8');
}

function sign(data) {
  return b64url(crypto.createHmac('sha256', EMAIL_UNSUBSCRIBE_SECRET).update(data).digest());
}

function makeUnsubscribeToken(email) {
  const payload = JSON.stringify({ e: normalizeEmail(email), t: Date.now() });
  const enc = b64url(payload);
  const sig = sign(enc);
  return `${enc}.${sig}`;
}

function verifyUnsubscribeToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return { ok: false, error: 'Invalid token' };
  const [enc, sig] = parts;
  const expected = sign(enc);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, error: 'Invalid signature' };
  }

  try {
    const payload = JSON.parse(b64urlDecode(enc));
    const email = normalizeEmail(payload.e);
    if (!email || !email.includes('@')) return { ok: false, error: 'Invalid email in token' };
    return { ok: true, email };
  } catch {
    return { ok: false, error: 'Malformed token payload' };
  }
}

function unsubscribeUrlFor(email) {
  const token = makeUnsubscribeToken(email);
  return `${APP_BASE_URL.replace(/\/$/, '')}/unsubscribe?token=${encodeURIComponent(token)}`;
}

function appendUnsubscribeHtml(htmlBody, email) {
  const unsubUrl = unsubscribeUrlFor(email);
  const footer = `<hr style="border:none;border-top:1px solid #eee;margin:24px 0" /><p style="font-size:12px;color:#666;line-height:1.4">You are receiving this email from KiddBusy. <a href="${unsubUrl}">Unsubscribe</a> from marketing emails.</p>`;
  if (String(htmlBody || '').includes('</body>')) {
    return String(htmlBody).replace('</body>', `${footer}</body>`);
  }
  return `${htmlBody}${footer}`;
}

function appendUnsubscribeText(textBody, email) {
  const unsubUrl = unsubscribeUrlFor(email);
  return `${String(textBody || '').trim()}\n\n---\nUnsubscribe from marketing emails: ${unsubUrl}`;
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase configuration missing');
  }
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

async function isUnsubscribed(email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  try {
    const { response, data } = await sbFetch(`email_preferences?select=email,unsubscribed&email=eq.${encodeURIComponent(e)}&limit=1`);
    if (!response.ok || !Array.isArray(data) || data.length === 0) return false;
    return !!data[0].unsubscribed;
  } catch {
    return false;
  }
}

async function setUnsubscribed(email, reason = 'recipient_unsubscribe', source = 'unsubscribe_link') {
  const e = normalizeEmail(email);
  if (!e) throw new Error('Invalid email');

  const now = new Date().toISOString();
  await sbFetch('email_preferences?on_conflict=email', {
    method: 'POST',
    body: {
      email: e,
      unsubscribed: true,
      unsubscribed_at: now,
      source,
      reason,
      updated_at: now
    },
    prefer: 'resolution=merge-duplicates,return=minimal'
  });

  // Optional sync to outreach pipeline.
  try {
    await sbFetch(`owner_marketing_leads?lead_email=eq.${encodeURIComponent(e)}`, {
      method: 'PATCH',
      body: { outreach_stage: 'opted_out', status: 'rejected' },
      prefer: 'return=minimal'
    });
  } catch {
    // non-blocking
  }
}

async function logEmailSend({ to, subject, campaignType, status, resendId = null, error = null }) {
  try {
    await sbFetch('email_send_log', {
      method: 'POST',
      body: {
        to_email: normalizeEmail(to),
        subject: String(subject || '').slice(0, 400),
        campaign_type: String(campaignType || 'marketing').slice(0, 100),
        status: String(status || 'unknown').slice(0, 40),
        resend_id: resendId,
        error_message: error ? String(error).slice(0, 1200) : null
      },
      prefer: 'return=minimal'
    });
  } catch {
    // table may not exist yet; keep email flow resilient
  }
}

async function sendCompliantEmail({ to, subject, body, fromName = 'KiddBusy', campaignType = 'marketing', allowSuppressedBypass = false }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const email = normalizeEmail(to);
  if (!email) throw new Error('Invalid recipient email');

  const suppressed = !allowSuppressedBypass && await isUnsubscribed(email);
  if (suppressed) {
    await logEmailSend({ to: email, subject, campaignType, status: 'suppressed_unsubscribed' });
    return { success: true, suppressed: true };
  }

  const rawBody = String(body || '');
  const isHtml = rawBody.trim().startsWith('<');
  const finalHtml = isHtml ? appendUnsubscribeHtml(rawBody, email) : null;
  const finalText = isHtml ? null : appendUnsubscribeText(rawBody, email);
  const unsubUrl = unsubscribeUrlFor(email);

  const payload = {
    from: `${fromName} <${RESEND_FROM_EMAIL}>`,
    to: [email],
    subject,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    },
    ...(isHtml ? { html: finalHtml } : { text: finalText })
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok) {
    await logEmailSend({ to: email, subject, campaignType, status: 'failed', error: result && (result.message || result.name || JSON.stringify(result)) });
    throw new Error(result && (result.message || result.name) ? (result.message || result.name) : 'Email failed');
  }

  await logEmailSend({ to: email, subject, campaignType, status: 'sent', resendId: result.id || null });
  return { success: true, suppressed: false, id: result.id || null };
}

module.exports = {
  sendCompliantEmail,
  setUnsubscribed,
  verifyUnsubscribeToken,
  normalizeEmail,
  makeUnsubscribeToken,
  unsubscribeUrlFor,
  isUnsubscribed
};
