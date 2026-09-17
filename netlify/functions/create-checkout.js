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
  try {
    const body = JSON.parse(event.body || '{}');
    quantity = Math.max(1, Math.min(20, parseInt(body.quantity, 10) || 1));
    if (body.locale === 'es' || body.locale === 'en') locale = body.locale;
  } catch (_) { /* fall back to defaults */ }

  const origin =
    event.headers.origin ||
    (event.headers.host ? 'https://' + event.headers.host : '');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale,
      metadata: { quantity: String(quantity), locale: locale === 'auto' ? 'en' : locale },
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
    });

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
