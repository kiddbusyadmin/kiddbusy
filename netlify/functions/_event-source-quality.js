'use strict';

const TRUSTED_AGGREGATOR_DOMAINS = new Set([
  'eventbrite.com',
  'allevents.in',
  'facebook.com',
  'mommypoppins.com',
  'metrosfamilymagazine.com',
  'redtri.com',
  'patch.com',
  '10times.com'
]);

const BLOCKED_DOMAINS = new Set([
  'google.com',
  'bing.com',
  'yahoo.com',
  'duckduckgo.com',
  'yelp.com',
  'tripadvisor.com',
  'instagram.com',
  'tiktok.com',
  'x.com',
  'twitter.com',
  'pinterest.com'
]);

function rootDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function classifyEventSourceUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return { allowed: false, tier: 'blocked', domain: '', reason: 'missing_url' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return { allowed: false, tier: 'blocked', domain: '', reason: 'invalid_url' };
  }

  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { allowed: false, tier: 'blocked', domain: '', reason: 'invalid_protocol' };
  }

  const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
  const domain = rootDomain(host);
  const path = String(parsed.pathname || '').toLowerCase();

  if (!domain) return { allowed: false, tier: 'blocked', domain: '', reason: 'missing_domain' };

  if (
    BLOCKED_DOMAINS.has(domain) ||
    (domain === 'google.com' && (path.includes('/search') || path.includes('/maps') || path === '/' || path === ''))
  ) {
    return { allowed: false, tier: 'blocked', domain: domain, reason: 'blocked_domain' };
  }

  if (domain.endsWith('.gov') || domain.endsWith('.edu')) {
    return { allowed: true, tier: 'official', domain: domain };
  }

  if (TRUSTED_AGGREGATOR_DOMAINS.has(domain)) {
    return { allowed: true, tier: 'trusted_aggregator', domain: domain };
  }

  if (domain.endsWith('.org')) {
    return { allowed: true, tier: 'official_like_org', domain: domain };
  }

  // Accept direct venue/organization pages by default, but mark as unknown for monitoring.
  return { allowed: true, tier: 'unknown', domain: domain };
}

module.exports = {
  classifyEventSourceUrl
};

