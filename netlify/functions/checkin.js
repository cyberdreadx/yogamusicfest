// Door check-in: validate a scanned ticket and mark it used (single entry).
// Called by /checkin.html. Protected by a shared staff PIN (env: CHECKIN_PIN).
//
// POST { pin, code, mode? }
//   code  = scanned text ("TYMF2026|TYMF-XXXX|x2") or a plain code ("TYMF-XXXX")
//   mode  = "peek" to look up without marking used (optional)
// Response { status, code?, order?, message? }
//   status: ok | used | invalid | error

const { getStore } = require('@netlify/blobs');

function json(status, obj) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { status: 'error', message: 'Method not allowed' });

  const pin = process.env.CHECKIN_PIN;
  if (!pin) return json(500, { status: 'error', message: 'Check-in not configured (set CHECKIN_PIN).' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  if (String(body.pin || '') !== String(pin)) {
    return json(401, { status: 'error', message: 'Wrong PIN' });
  }

  const raw = String(body.code || '').trim();
  const m = raw.match(/TYMF-[A-Z0-9]+/i);
  const code = (m ? m[0] : raw).toUpperCase();
  if (!code) return json(200, { status: 'invalid', message: 'No code' });

  const store = getStore('orders');
  let order;
  try {
    order = await store.get(code, { type: 'json' });
  } catch (e) {
    return json(500, { status: 'error', message: 'Lookup failed: ' + (e && e.message) });
  }

  if (!order) return json(200, { status: 'invalid', code, message: 'Not found' });
  if (order.used) return json(200, { status: 'used', code, order });
  if (body.mode === 'peek') return json(200, { status: 'ok', code, order });

  order.used = true;
  order.usedAt = new Date().toISOString();
  try {
    await store.setJSON(code, order);
  } catch (e) {
    return json(500, { status: 'error', message: 'Save failed: ' + (e && e.message) });
  }

  return json(200, { status: 'ok', code, order });
};
