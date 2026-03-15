const { sendCompliantEmail } = require('./_email-compliance');

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://kiddbusy.com';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PAYMENT_LINK_SPONSORED = process.env.STRIPE_PAYMENT_LINK_SPONSORED || '';
const STRIPE_PAYMENT_LINK_BANNER = process.env.STRIPE_PAYMENT_LINK_BANNER || '';
const STRIPE_PAYMENT_LINK_BUNDLE = process.env.STRIPE_PAYMENT_LINK_BUNDLE || '';

function normalizePlan(planRaw) {
  const v = String(planRaw || '').toLowerCase();
  if (v.includes('bundle') || v.includes('219')) return 'bundle';
  if (v.includes('banner') || v.includes('199')) return 'banner';
  return 'sponsored';
}

function planMeta(planRaw) {
  const p = normalizePlan(planRaw);
  if (p === 'banner') {
    return { key: 'banner', amountCents: 19900, amountLabel: '$199/mo', title: 'Banner Ad' };
  }
  if (p === 'bundle') {
    return { key: 'bundle', amountCents: 21900, amountLabel: '$219/mo', title: 'Full Visibility Bundle' };
  }
  return { key: 'sponsored', amountCents: 4900, amountLabel: '$49/mo', title: 'Sponsored Listing' };
}

function paymentLinkFromEnv(planKey) {
  if (planKey === 'banner') return STRIPE_PAYMENT_LINK_BANNER || '';
  if (planKey === 'bundle') return STRIPE_PAYMENT_LINK_BUNDLE || '';
  return STRIPE_PAYMENT_LINK_SPONSORED || '';
}

async function createStripeCheckoutLink(sponsorship, plan) {
  // For full automation, prefer dynamic Checkout Sessions so metadata can map
  // webhook events back to a specific sponsorship row.
  if (!STRIPE_SECRET_KEY) {
    const staticLink = paymentLinkFromEnv(plan.key);
    if (staticLink) return staticLink;
    throw new Error('Stripe checkout is not configured (missing STRIPE_SECRET_KEY or payment links)');
  }

  const firstName = String(sponsorship.first_name || '').trim();
  const businessName = String(sponsorship.business_name || 'Your business').trim();
  const city = String(sponsorship.city || '').trim();
  const descParts = [businessName, city].filter(Boolean);
  const productDescription = descParts.length ? descParts.join(' - ') : 'KiddBusy sponsorship plan';

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', `${APP_BASE_URL.replace(/\/$/, '')}/?sponsorship=payment_success`);
  params.set('cancel_url', `${APP_BASE_URL.replace(/\/$/, '')}/?sponsorship=payment_cancelled`);
  params.set('allow_promotion_codes', 'true');
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(plan.amountCents));
  params.set('line_items[0][price_data][recurring][interval]', 'month');
  params.set('line_items[0][price_data][product_data][name]', `KiddBusy ${plan.title}`);
  params.set('line_items[0][price_data][product_data][description]', productDescription);
  params.set('metadata[sponsorship_id]', String(sponsorship.id || ''));
  params.set('client_reference_id', String(sponsorship.id || ''));
  params.set('metadata[plan]', plan.key);
  params.set('metadata[business_name]', businessName);
  params.set('metadata[first_name]', firstName);
  params.set('metadata[city]', city);
  if (sponsorship.email) params.set('customer_email', String(sponsorship.email).trim());

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const data = await response.json();
  if (!response.ok || !data || !data.url) {
    const detail = data && (data.error ? (data.error.message || data.error.type) : JSON.stringify(data));
    throw new Error(`Stripe checkout session failed${detail ? `: ${detail}` : ''}`);
  }
  return String(data.url);
}

function paymentEmailHtml({ firstName, businessName, plan, checkoutUrl }) {
  const greet = firstName ? `Hi ${firstName},` : 'Hi there,';
  const safeBiz = businessName || 'your business';
  return [
    '<div style="margin:0;padding:0;background:#f6f3ff;font-family:Arial,Helvetica,sans-serif;color:#241f38">',
    '<div style="max-width:620px;margin:0 auto;padding:24px 16px">',
    '<div style="background:#ffffff;border:1px solid #e8ddff;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(36,31,56,0.08)">',
    '<div style="padding:18px 20px;background:linear-gradient(90deg,#bfa6ff,#8fd9ff)">',
    '<div style="font-size:20px;font-weight:700;color:#1f143f;letter-spacing:.2px">KiddBusy Sponsorship</div>',
    '<div style="margin-top:4px;font-size:13px;color:#2d1a52;opacity:.9">Secure checkout via Stripe</div>',
    '</div>',
    '<div style="padding:20px 20px 16px">',
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">${greet}</p>`,
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">Great news: your <strong>${safeBiz}</strong> sponsorship has been approved.</p>`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55">To activate your placement, complete your secure payment for the <strong>${plan.title}</strong> plan (${plan.amountLabel}).</p>`,
    `<a href="${checkoutUrl}" style="display:inline-block;background:#5f38e6;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:10px">Complete Secure Payment</a>`,
    '<p style="margin:16px 0 0;font-size:13px;line-height:1.55;color:#574f72">You will see Stripe-hosted checkout and receive a payment confirmation immediately after completion.</p>',
    '<p style="margin:12px 0 0;font-size:13px;line-height:1.55;color:#574f72">Questions? Reply directly to this email and we will help right away.</p>',
    '<p style="margin:16px 0 0;font-size:14px;line-height:1.55">The KiddBusy Team</p>',
    '</div>',
    '</div>',
    '</div>',
    '</div>'
  ].join('');
}

async function triggerSponsorshipPaymentRequestEmail({ sponsorship, activationSource = 'unknown' }) {
  const row = sponsorship || {};
  const toEmail = String(row.email || '').trim();
  if (!toEmail || !toEmail.includes('@')) {
    return { sent: false, skipped: true, reason: 'missing_email' };
  }

  const plan = planMeta(row.plan);
  const checkoutUrl = await createStripeCheckoutLink(row, plan);
  const firstName = String(row.first_name || '').trim();
  const businessName = String(row.business_name || '').trim();
  const subject = `Your KiddBusy sponsorship is approved — activate ${plan.title}`;
  const html = paymentEmailHtml({ firstName, businessName, plan, checkoutUrl });

  const sendResult = await sendCompliantEmail({
    to: toEmail,
    subject,
    body: html,
    fromName: 'KiddBusy Team',
    campaignType: `sponsorship_payment_request_${activationSource}`
  });

  return {
    sent: !!(sendResult && sendResult.success),
    suppressed: !!(sendResult && sendResult.suppressed),
    to: toEmail,
    plan: plan.key,
    checkout_url: checkoutUrl
  };
}

module.exports = {
  triggerSponsorshipPaymentRequestEmail,
  planMeta,
  normalizePlan
};
