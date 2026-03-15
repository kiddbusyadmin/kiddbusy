const crypto = require('crypto');
const { buildFinanceSnapshot, upsertFinanceSnapshot } = require('./_accounting-core');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function nowIso() {
  return new Date().toISOString();
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
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { response: res, data };
}

function getRawBody(event) {
  const raw = event.body || '';
  if (event.isBase64Encoded) {
    return Buffer.from(raw, 'base64').toString('utf8');
  }
  return raw;
}

function verifyStripeSignature(rawBody, signatureHeader) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
  const header = String(signatureHeader || '').trim();
  if (!header) throw new Error('Missing Stripe signature header');

  const parts = header.split(',').map((p) => p.trim());
  let timestamp = '';
  const v1 = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.startsWith('t=')) timestamp = p.slice(2);
    if (p.startsWith('v1=')) v1.push(p.slice(3));
  }
  if (!timestamp || !v1.length) throw new Error('Invalid Stripe signature header');

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signedPayload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let match = false;
  for (let i = 0; i < v1.length; i += 1) {
    const sig = String(v1[i] || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(sig)) continue;
    const sigBuf = Buffer.from(sig, 'hex');
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      match = true;
      break;
    }
  }
  if (!match) throw new Error('Stripe signature mismatch');
}

function firstDefined(values, fallback) {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return fallback == null ? null : fallback;
}

function normalizePlan(planRaw) {
  const v = String(planRaw || '').toLowerCase();
  if (v.includes('bundle') || v.includes('219')) return 'bundle';
  if (v.includes('banner') || v.includes('199')) return 'banner';
  return 'sponsored';
}

function parseListingId(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const id = Math.floor(n);
  return id > 0 ? id : null;
}

function mergeMetadata(base, patch) {
  return Object.assign({}, base || {}, patch || {});
}

async function getListingById(listingId) {
  const id = parseListingId(listingId);
  if (!id) return null;
  const q = `listings?listing_id=eq.${encodeURIComponent(String(id))}&select=listing_id,name,city,status,is_sponsored&limit=1`;
  const out = await sbFetch(q);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function findListingCandidates(city, businessName) {
  const c = String(city || '').trim();
  const b = String(businessName || '').trim();
  if (!c || !b) return [];
  const q = `listings?select=listing_id,name,city,status&city=ilike.${encodeURIComponent(c)}&name=ilike.${encodeURIComponent(b)}&status=eq.active&limit=5`;
  const out = await sbFetch(q);
  if (!out.response.ok || !Array.isArray(out.data)) return [];
  return out.data;
}

async function recordLinkException(args) {
  const p = args || {};
  const sponsorship = p.sponsorship || {};
  const body = {
    sponsorship_id: firstDefined([p.sponsorship_id, sponsorship.id], null),
    stripe_event_id: firstDefined([p.stripe_event_id], null),
    event_type: firstDefined([p.event_type], null),
    listing_id: parseListingId(firstDefined([p.listing_id, sponsorship.listing_id], null)),
    business_name: String(firstDefined([p.business_name, sponsorship.business_name], '') || ''),
    city: String(firstDefined([p.city, sponsorship.city], '') || ''),
    issue_code: String(p.issue_code || 'listing_link_issue').slice(0, 100),
    issue_detail: String(p.issue_detail || '').slice(0, 600),
    status: 'open',
    payload: p.payload || {}
  };
  try {
    await sbFetch('sponsorship_link_exceptions', { method: 'POST', body: body });
  } catch (_) {}
}

async function getSponsorshipById(id) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  const q = `sponsorships?id=eq.${encodeURIComponent(sid)}&select=*&limit=1`;
  const out = await sbFetch(q);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function getSponsorshipBySubscription(subscriptionId) {
  const sub = String(subscriptionId || '').trim();
  if (!sub) return null;
  const q = `sponsorships?stripe_subscription_id=eq.${encodeURIComponent(sub)}&select=*&limit=1`;
  const out = await sbFetch(q);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function getSponsorshipByCustomer(customerId) {
  const cid = String(customerId || '').trim();
  if (!cid) return null;
  const q = `sponsorships?stripe_customer_id=eq.${encodeURIComponent(cid)}&select=*&order=created_at.desc&limit=1`;
  const out = await sbFetch(q);
  if (!out.response.ok || !Array.isArray(out.data) || !out.data.length) return null;
  return out.data[0];
}

async function patchSponsorship(id, patch) {
  const sid = String(id || '').trim();
  if (!sid) return null;
  const out = await sbFetch(`sponsorships?id=eq.${encodeURIComponent(sid)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: patch
  });
  if (!out.response.ok) {
    throw new Error('Failed to update sponsorship');
  }
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function insertStripeEventBase(evt, sponsorshipId, customerId, subscriptionId, listingId) {
  const body = {
    event_id: String(evt.id || ''),
    event_type: String(evt.type || 'unknown'),
    sponsorship_id: sponsorshipId ? String(sponsorshipId) : null,
    stripe_customer_id: customerId ? String(customerId) : null,
    stripe_subscription_id: subscriptionId ? String(subscriptionId) : null,
    listing_id: parseListingId(listingId),
    payload: evt,
    processing_status: 'received',
    created_at: nowIso()
  };
  let out = await sbFetch('stripe_events', { method: 'POST', body: body, prefer: 'return=representation' });
  if (!out.response.ok) {
    const detail = JSON.stringify(out.data || {});
    if (detail.indexOf('listing_id') >= 0) {
      const fallbackBody = Object.assign({}, body);
      delete fallbackBody.listing_id;
      out = await sbFetch('stripe_events', { method: 'POST', body: fallbackBody, prefer: 'return=representation' });
    }
  }
  if (out.response.ok) return { inserted: true, row: Array.isArray(out.data) ? out.data[0] : out.data };
  const msg = JSON.stringify(out.data || {});
  if (String(msg).indexOf('duplicate key') >= 0 || String(msg).indexOf('23505') >= 0) {
    return { inserted: false, duplicate: true };
  }
  throw new Error('Failed to insert stripe_events row');
}

async function finalizeStripeEvent(eventId, status, sponsorshipId, errorMsg) {
  await sbFetch(`stripe_events?event_id=eq.${encodeURIComponent(String(eventId || ''))}`, {
    method: 'PATCH',
    body: {
      processing_status: status,
      sponsorship_id: sponsorshipId ? String(sponsorshipId) : null,
      processing_error: errorMsg ? String(errorMsg).slice(0, 1000) : null,
      processed_at: nowIso()
    }
  });
}

async function stripeGet(path) {
  if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) throw new Error('Stripe API read failed');
  return data || {};
}

async function ensureSponsorshipListingId(sponsorshipRow, eventInfo, preferredListingId) {
  const row = sponsorshipRow || {};
  const evt = eventInfo || {};
  const existingId = parseListingId(row.listing_id);
  if (existingId) {
    const existing = await getListingById(existingId);
    if (existing) return { listing_id: existingId, source: 'sponsorship_row' };
  }

  const preferredId = parseListingId(preferredListingId);
  if (preferredId) {
    const listing = await getListingById(preferredId);
    if (listing) {
      const updated = await patchSponsorship(row.id, {
        listing_id: preferredId,
        metadata: mergeMetadata(row.metadata, { stripe_listing_link_source: 'metadata_listing_id' })
      });
      return { listing_id: preferredId, source: 'metadata', sponsorship: updated || row };
    }
  }

  const candidates = await findListingCandidates(row.city, row.business_name);
  if (candidates.length === 1) {
    const cid = parseListingId(candidates[0].listing_id);
    const updated = await patchSponsorship(row.id, {
      listing_id: cid,
      metadata: mergeMetadata(row.metadata, { stripe_listing_link_source: 'city_business_unique' })
    });
    return { listing_id: cid, source: 'city_business_unique', sponsorship: updated || row };
  }

  const issueCode = candidates.length > 1 ? 'listing_ambiguous' : 'listing_not_found';
  const candidateListingIds = candidates.map((c) => parseListingId(c && c.listing_id)).filter(Boolean);
  await recordLinkException({
    sponsorship: row,
    stripe_event_id: evt.id || null,
    event_type: evt.type || null,
    issue_code: issueCode,
    issue_detail: candidates.length > 1
      ? `Multiple active listing matches for "${row.business_name}" in "${row.city}".`
      : `No active listing match for "${row.business_name}" in "${row.city}".`,
    payload: { candidate_listing_ids: candidateListingIds }
  });
  return { listing_id: null, source: issueCode, candidate_listing_ids: candidateListingIds };
}

async function syncListingSponsorFlag(sponsorshipRow, shouldBeSponsored, eventInfo, preferredListingId) {
  const row = sponsorshipRow || {};
  const plan = normalizePlan(row.plan);
  if (!(plan === 'sponsored' || plan === 'bundle')) return { updated: false, reason: 'plan_not_listing_based' };

  const ensured = await ensureSponsorshipListingId(row, eventInfo, preferredListingId);
  const listingId = parseListingId(ensured && ensured.listing_id);
  if (!listingId) {
    return { updated: false, reason: 'listing_link_missing', link_source: ensured ? ensured.source : null };
  }

  if (!shouldBeSponsored) {
    const activeCheck = await sbFetch(
      `sponsorships?select=id&listing_id=eq.${encodeURIComponent(String(listingId))}&status=in.(active,cancel_at_period_end)&limit=2`
    );
    const activeRows = activeCheck.response.ok && Array.isArray(activeCheck.data) ? activeCheck.data : [];
    if (activeRows.length > 0) return { updated: false, reason: 'other_active_sponsorship_exists', listing_id: listingId };
  }

  await sbFetch(`listings?listing_id=eq.${encodeURIComponent(String(listingId))}`, {
    method: 'PATCH',
    body: { is_sponsored: !!shouldBeSponsored }
  });
  return { updated: true, listing_id: listingId, link_source: ensured ? ensured.source : null };
}

async function handleCheckoutSessionCompleted(evt, session) {
  const metadata = session && session.metadata ? session.metadata : {};
  const metadataListingId = firstDefined([metadata.listing_id], null);
  const sponsorshipId = firstDefined([
    metadata.sponsorship_id,
    session.client_reference_id
  ], null);
  let sponsorship = await getSponsorshipById(sponsorshipId);
  if (!sponsorship) {
    sponsorship = await getSponsorshipBySubscription(session.subscription);
  }
  if (!sponsorship) {
    sponsorship = await getSponsorshipByCustomer(session.customer);
  }
  if (!sponsorship) {
    await recordLinkException({
      sponsorship_id: sponsorshipId,
      stripe_event_id: evt.id,
      event_type: evt.type,
      listing_id: metadataListingId,
      business_name: metadata.business_name || null,
      city: metadata.city || null,
      issue_code: 'sponsorship_not_found',
      issue_detail: 'checkout.session.completed did not match any sponsorship row',
      payload: { metadata: metadata }
    });
    return { status: 'ignored', reason: 'sponsorship_not_found' };
  }

  const ensured = await ensureSponsorshipListingId(sponsorship, evt, metadataListingId);
  const listingId = parseListingId(firstDefined([ensured && ensured.listing_id, sponsorship.listing_id], null));

  const patch = {
    status: 'active',
    listing_id: listingId,
    stripe_checkout_session_id: firstDefined([session.id, sponsorship.stripe_checkout_session_id], null),
    stripe_customer_id: firstDefined([session.customer, sponsorship.stripe_customer_id], null),
    stripe_subscription_id: firstDefined([session.subscription, sponsorship.stripe_subscription_id], null),
    cancel_at_period_end: false,
    approved_at: sponsorship.approved_at || nowIso(),
    activated_at: sponsorship.activated_at || nowIso(),
    last_payment_at: nowIso(),
    payment_error: null,
    metadata: mergeMetadata(sponsorship.metadata, {
      stripe_last_event: evt.id,
      stripe_listing_link_source: ensured && ensured.source ? ensured.source : null
    })
  };
  const updated = await patchSponsorship(sponsorship.id, patch);
  await syncListingSponsorFlag(updated || sponsorship, true, evt, listingId);
  return { status: 'processed', sponsorship_id: String(sponsorship.id) };
}

async function handleInvoicePaid(evt, invoice) {
  let sponsorship = await getSponsorshipBySubscription(invoice.subscription);
  if (!sponsorship) sponsorship = await getSponsorshipByCustomer(invoice.customer);
  if (!sponsorship) {
    await recordLinkException({
      stripe_event_id: evt.id,
      event_type: evt.type,
      issue_code: 'sponsorship_not_found',
      issue_detail: 'invoice.paid did not match any sponsorship row',
      payload: { customer: invoice.customer || null, subscription: invoice.subscription || null }
    });
    return { status: 'ignored', reason: 'sponsorship_not_found' };
  }

  const line0 = Array.isArray(invoice.lines && invoice.lines.data) && invoice.lines.data[0] ? invoice.lines.data[0] : null;
  const periodEnd = line0 && line0.period && line0.period.end ? new Date(Number(line0.period.end) * 1000).toISOString() : null;
  const priceId = line0 && line0.price && line0.price.id ? String(line0.price.id) : null;
  const ensured = await ensureSponsorshipListingId(sponsorship, evt, null);
  const listingId = parseListingId(firstDefined([ensured && ensured.listing_id, sponsorship.listing_id], null));
  const patch = {
    status: 'active',
    listing_id: listingId,
    stripe_customer_id: firstDefined([invoice.customer, sponsorship.stripe_customer_id], null),
    stripe_subscription_id: firstDefined([invoice.subscription, sponsorship.stripe_subscription_id], null),
    stripe_price_id: firstDefined([priceId, sponsorship.stripe_price_id], null),
    current_period_end: firstDefined([periodEnd, sponsorship.current_period_end], null),
    cancel_at_period_end: false,
    last_payment_at: nowIso(),
    payment_error: null,
    metadata: mergeMetadata(sponsorship.metadata, {
      stripe_last_event: evt.id,
      stripe_listing_link_source: ensured && ensured.source ? ensured.source : null
    })
  };
  const updated = await patchSponsorship(sponsorship.id, patch);
  await syncListingSponsorFlag(updated || sponsorship, true, evt, listingId);
  return { status: 'processed', sponsorship_id: String(sponsorship.id) };
}

async function handleInvoiceFailed(evt, invoice) {
  let sponsorship = await getSponsorshipBySubscription(invoice.subscription);
  if (!sponsorship) sponsorship = await getSponsorshipByCustomer(invoice.customer);
  if (!sponsorship) return { status: 'ignored', reason: 'sponsorship_not_found' };

  const patch = {
    status: 'past_due',
    stripe_customer_id: firstDefined([invoice.customer, sponsorship.stripe_customer_id], null),
    stripe_subscription_id: firstDefined([invoice.subscription, sponsorship.stripe_subscription_id], null),
    payment_error: 'invoice_payment_failed',
    metadata: mergeMetadata(sponsorship.metadata, { stripe_last_event: evt.id })
  };
  await patchSponsorship(sponsorship.id, patch);
  return { status: 'processed', sponsorship_id: String(sponsorship.id) };
}

async function handleSubscriptionUpdated(evt, subscription) {
  let sponsorship = await getSponsorshipBySubscription(subscription.id);
  if (!sponsorship) sponsorship = await getSponsorshipByCustomer(subscription.customer);
  if (!sponsorship) return { status: 'ignored', reason: 'sponsorship_not_found' };

  const stripeStatus = String(subscription.status || '').toLowerCase();
  const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
  const periodEnd = subscription.current_period_end ? new Date(Number(subscription.current_period_end) * 1000).toISOString() : null;
  let nextStatus = sponsorship.status || 'approved_awaiting_payment';
  if (stripeStatus === 'active' || stripeStatus === 'trialing') {
    nextStatus = cancelAtPeriodEnd ? 'cancel_at_period_end' : 'active';
  } else if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') {
    nextStatus = 'past_due';
  } else if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') {
    nextStatus = 'cancelled';
  }

  const patch = {
    status: nextStatus,
    stripe_customer_id: firstDefined([subscription.customer, sponsorship.stripe_customer_id], null),
    stripe_subscription_id: firstDefined([subscription.id, sponsorship.stripe_subscription_id], null),
    current_period_end: firstDefined([periodEnd, sponsorship.current_period_end], null),
    cancel_at_period_end: cancelAtPeriodEnd,
    canceled_at: nextStatus === 'cancelled' ? nowIso() : sponsorship.canceled_at,
    metadata: mergeMetadata(sponsorship.metadata, { stripe_last_event: evt.id })
  };
  const updated = await patchSponsorship(sponsorship.id, patch);
  if (nextStatus === 'cancelled') {
    await syncListingSponsorFlag(updated || sponsorship, false, evt, null);
  } else if (nextStatus === 'active' || nextStatus === 'cancel_at_period_end') {
    await syncListingSponsorFlag(updated || sponsorship, true, evt, null);
  }
  return { status: 'processed', sponsorship_id: String(sponsorship.id) };
}

async function handleSubscriptionDeleted(evt, subscription) {
  let sponsorship = await getSponsorshipBySubscription(subscription.id);
  if (!sponsorship) sponsorship = await getSponsorshipByCustomer(subscription.customer);
  if (!sponsorship) return { status: 'ignored', reason: 'sponsorship_not_found' };

  const patch = {
    status: 'cancelled',
    stripe_customer_id: firstDefined([subscription.customer, sponsorship.stripe_customer_id], null),
    stripe_subscription_id: firstDefined([subscription.id, sponsorship.stripe_subscription_id], null),
    cancel_at_period_end: false,
    canceled_at: nowIso(),
    metadata: mergeMetadata(sponsorship.metadata, { stripe_last_event: evt.id })
  };
  const updated = await patchSponsorship(sponsorship.id, patch);
  await syncListingSponsorFlag(updated || sponsorship, false, evt, null);
  return { status: 'processed', sponsorship_id: String(sponsorship.id) };
}

async function dispatchStripeEvent(evt) {
  const obj = evt && evt.data ? evt.data.object : null;
  const type = String((evt && evt.type) || '');
  if (!obj || !type) return { status: 'ignored', reason: 'invalid_event' };

  if (type === 'checkout.session.completed') return handleCheckoutSessionCompleted(evt, obj);
  if (type === 'invoice.paid') return handleInvoicePaid(evt, obj);
  if (type === 'invoice.payment_failed') return handleInvoiceFailed(evt, obj);
  if (type === 'customer.subscription.updated') return handleSubscriptionUpdated(evt, obj);
  if (type === 'customer.subscription.deleted') return handleSubscriptionDeleted(evt, obj);
  return { status: 'ignored', reason: 'unhandled_event_type' };
}

exports.handler = async (event) => {
  if (String(event.httpMethod || 'GET').toUpperCase() !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase configuration missing' });
  }

  try {
    const rawBody = getRawBody(event);
    const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';
    verifyStripeSignature(rawBody, sig);

    const evt = JSON.parse(rawBody || '{}');
    const obj = evt && evt.data ? evt.data.object || {} : {};
    const preSponsorshipId = firstDefined([
      obj.metadata && obj.metadata.sponsorship_id,
      obj.client_reference_id
    ], null);
    const preListingId = firstDefined([
      obj.metadata && obj.metadata.listing_id,
      obj.listing_id
    ], null);
    const preCustomerId = firstDefined([obj.customer], null);
    const preSubscriptionId = firstDefined([obj.subscription, obj.id && String(evt.type || '').indexOf('customer.subscription.') === 0 ? obj.id : null], null);

    const eventInsert = await insertStripeEventBase(evt, preSponsorshipId, preCustomerId, preSubscriptionId, preListingId);
    if (eventInsert.duplicate) {
      return json(200, { received: true, duplicate: true, event_id: evt.id });
    }

    let result = null;
    try {
      result = await dispatchStripeEvent(evt);
      await finalizeStripeEvent(evt.id, result && result.status === 'processed' ? 'processed' : 'ignored', result && result.sponsorship_id, null);
    } catch (handlerErr) {
      await finalizeStripeEvent(evt.id, 'error', preSponsorshipId, String(handlerErr.message || handlerErr));
      throw handlerErr;
    }

    try {
      await upsertFinanceSnapshot(await buildFinanceSnapshot());
    } catch (_) {}

    return json(200, {
      received: true,
      event_id: evt.id,
      event_type: evt.type,
      result: result || { status: 'ignored' }
    });
  } catch (err) {
    return json(400, { error: String(err.message || err || 'Webhook processing failed') });
  }
};
