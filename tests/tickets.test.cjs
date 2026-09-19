const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(qty = 2, locale = 'en') {
  const db = new Map(), sent = [], payloads = [];
  const state = { failStorage: false, failEmail: false };
  const session = { id: 'cs_test_ticket_fixture_ABCDEFGH', payment_status: 'paid', livemode: true,
    metadata: { quantity: String(qty), locale, ref: 'host' }, amount_total: qty * 20000, currency: 'mxn',
    customer_details: { name: 'Test Buyer', email: 'buyer@example.invalid' } };
  const getStore = options => {
    const name = typeof options === 'string' ? options : options.name;
    if (!db.has(name)) db.set(name, new Map());
    const data = db.get(name);
    return {
      get: async key => data.has(key) ? structuredClone(data.get(key)) : null,
      setJSON: async (key, value, opts = {}) => {
        if (state.failStorage) throw Error('Storage unavailable');
        if (opts.onlyIfNew && data.has(key)) return { modified: false };
        data.set(key, structuredClone(value));
        return { modified: true, etag: 'test' };
      },
      list: async () => ({ blobs: [...data.keys()].map(key => ({ key })) })
    };
  };
  const env = { STRIPE_SECRET_KEY: 'test-placeholder', STRIPE_WEBHOOK_SECRET: 'test-placeholder',
    RESEND_API_KEY: 'test-placeholder', CHECKIN_PIN: 'staff-placeholder', ADMIN_PIN: 'admin-placeholder' };
  const cache = new Map();
  function load(file) {
    const filename = path.resolve(__dirname, '..', file);
    if (cache.has(filename)) return cache.get(filename);
    const mod = { exports: {} };
    const localRequire = id => {
      if (id === '@netlify/blobs') return { getStore, connectLambda() {} };
      if (id === 'stripe') return () => ({ webhooks: { constructEvent: () => ({ type: 'checkout.session.completed', data: { object: session } }) } });
      if (id === 'qrcode') return { toBuffer: async payload => { payloads.push(payload); return Buffer.from(payload); } };
      if (id === 'resend') return { Resend: class { emails = { send: async (mail, options) => {
        if (state.failEmail) return { error: { message: 'Provider unavailable' }, data: null };
        sent.push({ mail, options }); return { data: { id: 'email-' + sent.length }, error: null };
      }}; }};
      if (id.startsWith('.')) return load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), id + '.js')));
      return require(id);
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: mod, exports: mod.exports,
      require: localRequire, process: { env }, Buffer, console, fetch }, { filename });
    cache.set(filename, mod.exports);
    return mod.exports;
  }
  const issue = () => load('netlify/functions/stripe-webhook.js').handler({ headers: {}, body: '' });
  const scan = async (code, mode, pin = env.CHECKIN_PIN) => {
    const response = await load('netlify/functions/checkin.js').handler({ httpMethod: 'POST', body: JSON.stringify({ pin, code, mode }) });
    return { http: response.statusCode, ...JSON.parse(response.body) };
  };
  const report = async () => JSON.parse((await load('netlify/functions/report.js').handler({ httpMethod: 'POST', body: JSON.stringify({ pin: env.ADMIN_PIN }) })).body);
  return { db, sent, payloads, state, session, issue, scan, report, getStore };
}

test('two purchased tickets produce distinct codes, QR images and numbered single-person email cards', async () => {
  const f = fixture();
  assert.equal((await f.issue()).statusCode, 200);
  const order = [...f.db.get('orders').values()][0];
  assert.equal(f.db.get('orders').size, 1);
  assert.equal(order.ticketCodes.length, 2);
  assert.equal(new Set(order.ticketCodes).size, 2);
  assert.equal(f.sent[0].mail.attachments.length, 2);
  assert.equal((f.sent[0].mail.html.match(/Admits 1 person/g) || []).length, 2);
  assert.match(f.sent[0].mail.html, /Ticket 2 \/ 2/);
  assert.ok(f.payloads.every(p => p.endsWith('|x1')));
  assert.equal((await f.scan(order.code)).status, 'invalid');
  assert.equal((await f.scan(order.ticketCodes[0], 'peek')).status, 'ok');
  assert.equal((await f.scan(order.ticketCodes[0])).order.qty, 1);
  assert.equal((await f.scan(order.ticketCodes[0])).status, 'used');
  assert.equal((await f.scan(order.ticketCodes[1], 'peek')).status, 'ok');
  let report = await f.report();
  assert.equal(report.totals.orders, 1);
  assert.equal(report.totals.tickets, 2);
  assert.equal(report.totals.revenue, 40000);
  assert.equal(report.totals.commission, 200);
  assert.equal(report.orders[0].checkedIn, 1);
  assert.equal(report.orders[0].used, false);
  assert.equal((await f.scan(f.payloads[1])).status, 'ok');
  report = await f.report();
  assert.equal(report.orders[0].checkedIn, 2);
  assert.equal(report.orders[0].used, true);
});

test('concurrent scans admit a ticket exactly once', async () => {
  const f = fixture(1); await f.issue();
  const results = await Promise.all([f.scan(f.payloads[0]), f.scan(f.payloads[0])]);
  assert.deepEqual(results.map(r => r.status).sort(), ['ok', 'used']);
});

test('webhook retries preserve codes and consumed admissions without another email', async () => {
  const f = fixture(); await f.issue(); await f.scan(f.payloads[0]);
  const first = f.payloads[0];
  assert.equal((await f.issue()).statusCode, 200);
  assert.equal(f.sent.length, 2); // One buyer email and one organizer notification.
  assert.equal(f.db.get('tickets').size, 2);
  assert.equal((await f.scan(first)).status, 'used');
});

test('storage failure prevents ticket email; retry completes the same order', async () => {
  const f = fixture(); f.state.failStorage = true;
  assert.equal((await f.issue()).statusCode, 500);
  assert.equal(f.sent.length, 0);
  f.state.failStorage = false;
  assert.equal((await f.issue()).statusCode, 200);
  assert.equal(f.db.get('tickets').size, 2);
});

test('provider error fails webhook, retries reuse identical tickets', async () => {
  const f = fixture(); f.state.failEmail = true;
  assert.equal((await f.issue()).statusCode, 500);
  const codes = [...f.db.get('tickets').keys()];
  f.state.failEmail = false;
  assert.equal((await f.issue()).statusCode, 200);
  assert.deepEqual([...f.db.get('tickets').keys()], codes);
  assert.ok(f.sent[0].options.idempotencyKey);
});

test('legacy shared tickets remain valid and used legacy tickets are never reset', async () => {
  const f = fixture();
  const legacy = { code: 'TYMF-ABCDEFGH', session: f.session.id, qty: 2, used: false, email: 'buyer@example.invalid' };
  await f.getStore('orders').setJSON(legacy.code, legacy);
  assert.equal((await f.issue()).statusCode, 200);
  assert.equal(f.sent[0].mail.attachments.length, 1);
  assert.equal(f.db.has('tickets'), false);
  assert.equal((await f.scan(legacy.code)).order.qty, 2);
  assert.equal((await f.scan(legacy.code)).status, 'used');
  const g = fixture();
  await g.getStore('orders').setJSON(legacy.code, { ...legacy, used: true });
  await g.issue();
  assert.equal((await g.scan(legacy.code)).status, 'used');
});

test('Spanish maximum-size order, invalid quantity, invalid code and PIN', async () => {
  const f = fixture(20, 'es'); await f.issue();
  assert.equal(f.sent[0].mail.attachments.length, 20);
  assert.match(f.sent[0].mail.html, /Boleto 20 \/ 20/);
  assert.equal((await f.scan('TYMF-NOPE')).status, 'invalid');
  assert.equal((await f.scan(f.payloads[0], undefined, 'wrong')).http, 401);
  assert.equal((await fixture(21).issue()).statusCode, 400);
});
