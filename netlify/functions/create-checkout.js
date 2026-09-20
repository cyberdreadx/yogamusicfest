// Creates a Stripe Checkout Session for TYMF festival tickets.
// The secret key is read from the STRIPE_SECRET_KEY environment variable
// (set it in Netlify → Site settings → Environment variables). It is NEVER
// exposed to the browser and must never be committed to the repo.

const Stripe = require('stripe');

// $200.00 MXN per ticket, in centavos (MXN is a 2-decimal currency).
const UNIT_AMOUNT = 20000;
const CURRENCY = 'mxn';
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' }) };
  }
  const stripe = Stripe(key);

  // Parse + clamp the requested quantity; never trust the client for the price.
  let quantity = 1;
  let locale = 'auto';
  let ref = '';
  let source = '';
  let promoCode = '';
  let quote = false;
  try {
    const body = JSON.parse(event.body || '{}');
    if (typeof body.promoCode === 'string') promoCode = body.promoCode.trim().toUpperCase().slice(0, 100);
    quote = body.action === 'quote';
    quantity = Math.max(1, Math.min(20, parseInt(body.quantity, 10) || 1));
    if (body.locale === 'es' || body.locale === 'en') locale = body.locale;
    if (typeof body.ref === 'string') ref = body.ref.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    // Where the sale started, so we can return the buyer to the right page.
    if (body.source === 'checkout') source = 'checkout';
  } catch (_) { /* fall back to defaults */ }

  const origin =
    event.headers.origin ||
    (event.headers.host ? 'https://' + event.headers.host : '');

  // Referral commissions are tracked for separate Global Payouts payments.
  try {
    let promotion;
    if (promoCode) {
      const matches = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
      promotion = matches.data[0];
      const coupon = promotion && promotion.coupon;
      if (!promotion || promotion.customer || !coupon || !coupon.valid || coupon.percent_off !== 50 ||
          coupon.applies_to || promotion.restrictions?.first_time_transaction ||
          (promotion.expires_at && promotion.expires_at <= Date.now() / 1000) ||
          (promotion.restrictions?.minimum_amount &&
            (promotion.restrictions.minimum_amount_currency !== CURRENCY || quantity * UNIT_AMOUNT < promotion.restrictions.minimum_amount))) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid or unavailable discount code.' }) };
      }
    }
    if (quote) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ percentOff: promotion ? 50 : 0 }) };
    }
    const params = {
      mode: 'payment',
      ...(promotion ? { discounts: [{ promotion_code: promotion.id }] } : { allow_promotion_codes: true }),
      locale,
      metadata: {
        quantity: String(quantity),
        locale: locale === 'auto' ? 'en' : locale,
        ref,
        connect: '',
      },
      line_items: [
        {
          quantity,
          price_data: {
            currency: CURRENCY,
            unit_amount: UNIT_AMOUNT,
            product_data: {
              name: 'Tulum Yoga Music Fest 2026 — Festival Ticket',
              description: 'Saturday, September 26 · Oasis Tulum · Full-day access (11am–11pm)',
            },
          },
        },
      ],
      phone_number_collection: { enabled: true },
      success_url: origin + (source === 'checkout' ? '/checkout?paid=true' : '/?paid=true'),
      cancel_url: origin + (source === 'checkout' ? '/checkout' : '/#tickets'),
    };
    const session = await stripe.checkout.sessions.create(params);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Stripe error' }),
    };
  }
};
