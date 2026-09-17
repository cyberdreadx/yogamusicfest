// Public promoter self-service stats, gated by a per-promoter token.
// POST { code, token } -> that promoter's tickets sold + commission.

const { getStore, connectLambda } = require('@netlify/blobs');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

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

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const code = slug(body.code);
  const token = String(body.token || '');
  if (!code || !token) return json(400, { error: 'Missing code or token' });

  const rec = await getStore('promoter_tokens').get(code, { type: 'json' });
  if (!rec || rec.token !== token) return json(403, { error: 'Invalid link' });

  const orders = getStore('orders');
  let blobs = [];
  try { blobs = (await orders.list()).blobs || []; } catch (_) {}

  let tickets = 0, commission = 0, commissionAuto = 0, commissionOwed = 0, lastSale = null;
  for (const b of blobs) {
    if (b.key === '__diag__') continue;
    let o;
    try { o = await orders.get(b.key, { type: 'json' }); } catch (_) { continue; }
    if (!o || o.ref !== code) continue;
    const q = o.qty || 1;
    const c = typeof o.commission === 'number' ? o.commission : q * 100;
    tickets += q;
    commission += c;
    if (o.autoPaid) commissionAuto += c; else commissionOwed += c;
    if (!lastSale || o.createdAt > lastSale) lastSale = o.createdAt;
  }

  let paidManual = false;
  try { const pd = await getStore('payouts').get(code, { type: 'json' }); paidManual = !!(pd && pd.paid); } catch (_) {}
  let autoEnabled = false;
  try { const cs = await getStore('connect').get(code, { type: 'json' }); autoEnabled = !!(cs && cs.chargesEnabled && cs.payoutsEnabled); } catch (_) {}

  return json(200, { code, tickets, commission, commissionAuto, commissionOwed, paidManual, autoEnabled, lastSale });
};
