// Organizer dashboard API: sales + promoter commissions. PIN-gated (ADMIN_PIN).
// POST { pin }                          -> full report
// POST { pin, action:'setPaid', promoter, paid } -> mark a promoter paid/unpaid

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
      if (o) rows.push(o);
    } catch (_) {}
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
      if (!promo[o.ref]) promo[o.ref] = { code: o.ref, tickets: 0, revenue: 0, commission: 0 };
      promo[o.ref].tickets += q;
      promo[o.ref].revenue += o.amount || 0;
      promo[o.ref].commission += c;
      commission += c;
    }
  }

  const promoters = [];
  for (const k of Object.keys(promo)) {
    let pd = null;
    try { pd = await payouts.get(k, { type: 'json' }); } catch (_) {}
    promoters.push(Object.assign(promo[k], { paid: (pd && pd.paid) || false, paidAt: (pd && pd.paidAt) || null }));
  }
  promoters.sort((a, b) => b.commission - a.commission);

  return json(200, {
    orders: rows,
    promoters,
    totals: { orders: rows.length, tickets, revenue, commission },
  });
};
