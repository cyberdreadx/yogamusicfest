// TEMPORARY diagnostic — verifies Netlify Blobs works in this deploy. Remove after.
const { getStore, connectLambda } = require('@netlify/blobs');
exports.handler = async (event) => {
  try {
    connectLambda(event);
    const s = getStore('orders');
    await s.setJSON('__diag__', { t: 'ok' });
    const v = await s.get('__diag__', { type: 'json' });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, read: v }) };
  } catch (e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, name: e && e.name, error: e && e.message }) };
  }
};
