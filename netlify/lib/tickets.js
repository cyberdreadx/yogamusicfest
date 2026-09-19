const { createHash } = require('node:crypto');
const { getStore } = require('@netlify/blobs');

function store(name) {
  return getStore({ name, consistency: 'strong', fetch: async (...args) => {
    const response = await fetch(...args);
    // Conditional writes must never treat an HTTP failure as a successful claim.
    if (!response.ok && response.status !== 404 && response.status !== 412) {
      throw new Error('Ticket storage request failed (' + response.status + ')');
    }
    return response;
  }});
}

function codesFor(sessionId, quantity) {
  return Array.from({ length: quantity }, (_, i) => 'TYMF-' +
    createHash('sha256').update(sessionId + ':' + i).digest('hex').slice(0, 24).toUpperCase());
}

async function attendance(order) {
  const codes = order.ticketCodes || [order.code];
  const receipts = await Promise.all(codes.map(code => store('ticket-admissions').get(code, { type: 'json' })));
  const checkedIn = order.ticketCodes
    ? receipts.filter(Boolean).length
    : (order.used || receipts[0] ? order.qty || 1 : 0);
  return { ...order, checkedIn, used: checkedIn === (order.qty || 1),
    usedAt: receipts.filter(Boolean).map(r => r.usedAt).sort().pop() || order.usedAt || null };
}

module.exports = { store, codesFor, attendance };
