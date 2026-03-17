const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kiddbusy2024';
const AGENT_SESSION_SECRET = process.env.AGENT_SESSION_SECRET || ADMIN_PASSWORD;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function unbase64url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function signPayload(payloadText) {
  return crypto.createHmac('sha256', AGENT_SESSION_SECRET).update(payloadText).digest('hex');
}

function issueAgentSessionToken() {
  const payload = {
    scope: 'agent_proxy',
    exp: Date.now() + SESSION_TTL_MS
  };
  const encoded = base64url(JSON.stringify(payload));
  const sig = signPayload(encoded);
  return `${encoded}.${sig}`;
}

function verifyAgentSessionToken(token) {
  const raw = String(token || '').trim();
  if (!raw || raw.indexOf('.') < 0) return { ok: false, reason: 'missing_token' };
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid_token' };
  const encoded = parts[0];
  const sig = parts[1];
  const expected = signPayload(encoded);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload = null;
  try {
    payload = JSON.parse(unbase64url(encoded));
  } catch (_) {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!payload || payload.scope !== 'agent_proxy') return { ok: false, reason: 'bad_scope' };
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

function extractBearerToken(headers) {
  const auth = String((headers && (headers.authorization || headers.Authorization)) || '').trim();
  if (!auth) return '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || '').trim() : '';
}

module.exports = {
  ADMIN_PASSWORD,
  issueAgentSessionToken,
  verifyAgentSessionToken,
  extractBearerToken
};
