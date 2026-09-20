// Stripe Connect management for promoter auto-payouts. PIN-gated (ADMIN_PIN).
// Creates Express connected accounts (Mexico) and hosted onboarding links so a
// promoter's 50% is transferred to their own bank automatically at checkout.
//
// POST { pin, action, promoter, origin? }
//   action:'create'  -> create/find the account + return a fresh onboarding URL
//   action:'link'    -> new onboarding URL for an existing account
//   action:'status'  -> refresh + return onboarding status (stored in `connect`)
//   action:'list'    -> all promoter accounts + stored status

const Stripe = require('stripe');
const { getStore, connectLambda } = require('@netlify/blobs');

function json(status, obj) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const key = process.env.STRIPE_SECRET_KEY;
  const pin = process.env.ADMIN_PIN;
  if (!key) return json(500, { error: 'Stripe not configured' });
  if (!pin) return json(500, { error: 'Admin not configured (set ADMIN_PIN).' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  if (String(body.pin || '') !== String(pin)) return json(401, { error: 'Wrong PIN' });

  const stripe = Stripe(key);
  const store = getStore('connect');
  const origin = body.origin || event.headers.origin || (event.headers.host ? 'https://' + event.headers.host : '');
  const action = body.action;

  async function onboardingUrl(acctId, code) {
    const link = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: origin + '/admin?connect=' + code,
      return_url: origin + '/admin?connect=' + code,
      type: 'account_onboarding',
    });
    return link.url;
  }
  async function saveStatus(code, acctId, acct) {
    const rec = {
      acctId,
      detailsSubmitted: !!(acct && acct.details_submitted),
      chargesEnabled: !!(acct && acct.charges_enabled),
      payoutsEnabled: !!(acct && acct.payouts_enabled),
      updatedAt: new Date().toISOString(),
    };
    await store.setJSON(code, rec);
    return rec;
  }

  try {
    if (action === 'list') {
      const { blobs } = await store.list();
      const out = [];
      for (const b of blobs) {
        const rec = await store.get(b.key, { type: 'json' });
        if (rec) out.push(Object.assign({ code: b.key }, rec));
      }
      return json(200, { accounts: out });
    }

    const code = slug(body.promoter);
    if (!code) return json(200, { error: 'Missing promoter code' });

    if (action === 'create' || action === 'link') {
      return json(409, { error: 'Connect onboarding has been retired. Manage recipients and send commissions separately in Stripe Global Payouts.', url: 'https://dashboard.stripe.com/global-payouts/recipients' });
    }

    if (action === 'status') {
      const rec = await store.get(code, { type: 'json' });
      if (!rec || !rec.acctId) return json(200, { exists: false });
      const acct = await stripe.accounts.retrieve(rec.acctId);
      const saved = await saveStatus(code, rec.acctId, acct);
      return json(200, Object.assign({ exists: true, code }, saved));
    }

    return json(200, { error: 'Unknown action' });
  } catch (e) {
    return json(500, { error: (e && e.message) || 'Stripe error' });
  }
};
