// Organizer dashboard API: sales + promoter commissions. PIN-gated (ADMIN_PIN).
// POST { pin }                          -> full report
// POST { pin, action:'setPaid', promoter, paid } -> mark a promoter paid/unpaid

const { getStore, connectLambda } = require('@netlify/blobs');
const { attendance } = require('../lib/tickets');
const crypto = require('crypto');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const isLiveOrder = (o) => {
  if (!o) return false;
  if (typeof o.liveMode === 'boolean') return o.liveMode;
  return !/^cs_test_/i.test(String(o.session || ''));
};

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

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const pin = process.env.ADMIN_PIN;
  if (!pin) return json(500, { error: 'Admin not configured (set ADMIN_PIN).' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  if (String(body.pin || '') !== String(pin)) return json(401, { error: 'Wrong PIN' });

  const orders = getStore('orders');
  const payouts = getStore('payouts');

  // Mark a promoter paid / unpaid
  if (body.action === 'setPaid') {
    const p = String(body.promoter || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!p) return json(200, { error: 'no promoter' });
    await payouts.setJSON(p, { paid: !!body.paid, paidAt: body.paid ? new Date().toISOString() : null });
    return json(200, { ok: true });
  }

  // Ensure/return a promoter's private stats token (for their self-service page)
  if (body.action === 'promoLink') {
    const p = slug(body.promoter);
    if (!p) return json(200, { error: 'no promoter' });
    const tokens = getStore('promoter_tokens');
    let rec = await tokens.get(p, { type: 'json' });
    if (!rec || !rec.token) {
      rec = { token: crypto.randomBytes(9).toString('hex'), createdAt: new Date().toISOString() };
      await tokens.setJSON(p, rec);
    }
    return json(200, { code: p, token: rec.token });
  }

  // Load all orders
  let blobs = [];
  try {
    const res = await orders.list();
    blobs = res.blobs || [];
  } catch (e) {
    return json(500, { error: 'List failed: ' + (e && e.message) });
  }

  const rows = [];
  for (const b of blobs) {
    if (b.key === '__diag__') continue;
    try {
      const o = await orders.get(b.key, { type: 'json' });
      if (isLiveOrder(o)) rows.push(await attendance(o));
    } catch (_) { return json(500, { error: 'Order attendance could not be loaded. Please retry.' }); }
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const promo = {};
  let tickets = 0, revenue = 0, commission = 0;
  for (const o of rows) {
    const q = o.qty || 1;
    tickets += q;
    revenue += o.amount || 0; // centavos
    if (o.ref) {
      const c = typeof o.commission === 'number' ? o.commission : q * 100; // pesos
      if (!promo[o.ref]) promo[o.ref] = { code: o.ref, tickets: 0, revenue: 0, commission: 0, commissionAuto: 0, commissionOwed: 0 };
      promo[o.ref].tickets += q;
      promo[o.ref].revenue += o.amount || 0;
      promo[o.ref].commission += c;
      if (o.autoPaid) promo[o.ref].commissionAuto += c; else promo[o.ref].commissionOwed += c;
      commission += c;
    }
  }

  // Merge in Stripe Connect onboarding status (includes promoters with no sales yet)
  const connectMap = {};
  try {
    const cs = getStore('connect');
    const list = await cs.list();
    for (const b of (list.blobs || [])) {
      const r = await cs.get(b.key, { type: 'json' });
      if (r) connectMap[b.key] = r;
    }
  } catch (_) {}

  const codes = new Set([...Object.keys(promo), ...Object.keys(connectMap)]);
  const promoters = [];
  for (const k of codes) {
    const base = promo[k] || { code: k, tickets: 0, revenue: 0, commission: 0, commissionAuto: 0, commissionOwed: 0 };
    let pd = null;
    try { pd = await payouts.get(k, { type: 'json' }); } catch (_) {}
    const cm = connectMap[k];
    promoters.push(Object.assign(base, {
      paid: (pd && pd.paid) || false,
      paidAt: (pd && pd.paidAt) || null,
      connect: cm ? {
        acctId: cm.acctId,
        chargesEnabled: !!cm.chargesEnabled,
        payoutsEnabled: !!cm.payoutsEnabled,
        detailsSubmitted: !!cm.detailsSubmitted,
        ready: !!(cm.chargesEnabled && cm.payoutsEnabled),
      } : null,
    }));
  }
  promoters.sort((a, b) => b.commission - a.commission);

  return json(200, {
    orders: rows,
    promoters,
    totals: { orders: rows.length, tickets, revenue, commission },
  });
};
