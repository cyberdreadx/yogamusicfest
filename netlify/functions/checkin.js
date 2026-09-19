// Door check-in: validate a scanned ticket and mark it used (single entry).
// Called by /checkin.html. Protected by a shared staff PIN (env: CHECKIN_PIN).
//
// POST { pin, code, mode? }
//   code  = scanned text ("TYMF2026|TYMF-XXXX|x2") or a plain code ("TYMF-XXXX")
//   mode  = "peek" to look up without marking used (optional)
// Response { status, code?, order?, message? }
//   status: ok | used | invalid | error

const { connectLambda } = require('@netlify/blobs');
const { store } = require('../lib/tickets');

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
  connectLambda(event);
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

  try {
    const ticket = await store('tickets').get(code, { type: 'json' });
    const parent = await store('orders').get(ticket ? ticket.orderCode : code, { type: 'json' });
    if (!parent || (parent.ticketCodes && (!ticket || !parent.ticketCodes.includes(code)))) {
      return json(200, { status: 'invalid', code, message: 'Use an individual ticket QR code' });
    }
    const order = ticket ? { ...parent, code, qty: 1, orderCode: parent.code, ticketNumber: ticket.index } : parent;
    const admissions = store('ticket-admissions');
    const prior = await admissions.get(code, { type: 'json' });
    if (prior || parent.used) return json(200, { status: 'used', code,
      order: { ...order, used: true, usedAt: prior ? prior.usedAt : parent.usedAt } });
    if (body.mode === 'peek') return json(200, { status: 'ok', code, order: { ...order, used: false } });

    // One immutable claim per ticket: simultaneous scans cannot both admit it.
    const receipt = { usedAt: new Date().toISOString() };
    const claim = await admissions.setJSON(code, receipt, { onlyIfNew: true });
    if (!claim || typeof claim.modified !== 'boolean') throw new Error('Admission claim failed');
    const saved = await admissions.get(code, { type: 'json' });
    if (!saved) throw new Error('Admission was not saved');
    return json(200, { status: claim.modified ? 'ok' : 'used', code,
      order: { ...order, used: true, usedAt: saved.usedAt } });
  } catch (e) {
    return json(500, { status: 'error', message: 'Ticket lookup or check-in failed. Please retry.' });
  }
};