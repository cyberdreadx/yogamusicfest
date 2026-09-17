// Creates a Stripe Checkout Session for TYMF festival tickets.
// The secret key is read from the STRIPE_SECRET_KEY environment variable
// (set it in Netlify → Site settings → Environment variables). It is NEVER
// exposed to the browser and must never be committed to the repo.

const Stripe = require('stripe');
const { getStore, connectLambda } = require('@netlify/blobs');

// $200.00 MXN per ticket, in centavos (MXN is a 2-decimal currency).
const UNIT_AMOUNT = 20000;
const CURRENCY = 'mxn';
// Promoter share = 50% = $100.00/ticket. With a destination charge the platform
// keeps the application fee and the promoter (destination) gets the remainder.
const PROMOTER_SHARE = 10000; // centavos the platform keeps as its fee per ticket

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
  try {
    const body = JSON.parse(event.body || '{}');
    quantity = Math.max(1, Math.min(20, parseInt(body.quantity, 10) || 1));
    if (body.locale === 'es' || body.locale === 'en') locale = body.locale;
    if (typeof body.ref === 'string') ref = body.ref.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  } catch (_) { /* fall back to defaults */ }

  const origin =
    event.headers.origin ||
    (event.headers.host ? 'https://' + event.headers.host : '');

  // If this sale came via a promoter who has an onboarded Stripe Connect
  // account, split the payment automatically (destination charge).
  let promoterAcct = null;
  if (ref) {
    try {
      connectLambda(event);
      const rec = await getStore('connect').get(ref, { type: 'json' });
      if (rec && rec.acctId) {
        const acct = await stripe.accounts.retrieve(rec.acctId);
        if (acct && acct.charges_enabled && acct.payouts_enabled) {
          promoterAcct = rec.acctId;
        }
      }
    } catch (_) { /* fall back to a normal charge; commission tracked manually */ }
  }

  try {
    const params = {
      mode: 'payment',
      locale,
      metadata: {
        quantity: String(quantity),
        locale: locale === 'auto' ? 'en' : locale,
        ref,
        connect: promoterAcct ? '1' : '',
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
      success_url: origin + '/?paid=true',
      cancel_url: origin + '/#tickets',
    };
    if (promoterAcct) {
      params.payment_intent_data = {
        application_fee_amount: quantity * PROMOTER_SHARE, // platform keeps $100/ticket
        transfer_data: { destination: promoterAcct },      // promoter auto-receives the other $100
      };
    }
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
