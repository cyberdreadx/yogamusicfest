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
      get: async key => {
        if (state.staleReads && (name === 'orders' || name === 'tickets')) return null;
        if (state.failAttendance && name === 'ticket-admissions') throw Error('Attendance unavailable');
        return data.has(key) ? structuredClone(data.get(key)) : null;
      },
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

test('half-price orders issue every ticket and halve the promoter commission', async () => {
  const f = fixture(2);
  f.session.amount_total = 20000;
  assert.equal((await f.issue()).statusCode, 200);
  const order = [...f.db.get('orders').values()][0];
  assert.equal(order.commission, 100);
  assert.equal(order.ticketCodes.length, 2);
  assert.equal(f.sent[0].mail.attachments.length, 2);
  const report = await f.report();
  assert.equal(report.totals.revenue, 20000);
  assert.equal(report.totals.commission, 100);
  assert.equal((await f.issue()).statusCode, 200);
  assert.equal([...f.db.get('orders').values()][0].commission, 100);
});

test('concurrent scans admit a ticket exactly once', async () => {
  const f = fixture(1); await f.issue();
  const results = await Promise.all([f.scan(f.payloads[0]), f.scan(f.payloads[0])]);
  assert.deepEqual(results.map(r => r.status).sort(), ['ok', 'used']);
});

test('attendance failure preserves sales totals and explicitly marks counts unknown', async () => {
  const f = fixture(); await f.issue(); f.state.failAttendance = true;
  const report = await f.report();
  assert.equal(report.totals.tickets, 2);
  assert.equal(report.totals.revenue, 40000);
  assert.equal(report.totals.commission, 200);
  assert.equal(report.orders[0].checkedIn, null);
  assert.equal(report.orders[0].used, null);
  assert.equal(report.orders[0].attendanceUnavailable, true);
  assert.equal((await f.scan(f.payloads[0])).http, 500);
});

test('legacy orders without an embedded code use their storage key for attendance', async () => {
  const f = fixture();
  await f.getStore('orders').setJSON('TYMF-LEGACY', { qty: 2, amount: 40000, liveMode: true });
  await f.getStore('ticket-admissions').setJSON('TYMF-LEGACY', { usedAt: '2026-09-19T00:00:00Z' });
  const report = await f.report();
  assert.equal(report.orders[0].code, 'TYMF-LEGACY');
  assert.equal(report.orders[0].checkedIn, 2);
});

test('real Blobs SDK supports legacy Lambda context and preserves atomic admission writes', async () => {
  const blobs = require('@netlify/blobs');
  const originalContext = process.env.NETLIFY_BLOBS_CONTEXT;
  const originalFetch = global.fetch;
  const requests = [];
  try {
    blobs.connectLambda({ headers: { 'x-nf-site-id': 'fixture-site', 'x-nf-deploy-id': 'fixture-deploy' },
      blobs: Buffer.from(JSON.stringify({ url: 'https://blobs.example.invalid', token: 'fixture-token' })).toString('base64') });
    let claimed = false;
    global.fetch = async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'put') {
        if (claimed) return new Response(null, { status: 412 });
        claimed = true;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ usedAt: '2026-09-19T00:00:00Z' }), { status: 200 });
    };
    const { store } = require('../netlify/lib/tickets');
    const admissions = store('ticket-admissions');
    assert.ok((await admissions.get('TYMF-TEST', { type: 'json' })).usedAt);
    assert.equal((await admissions.setJSON('TYMF-TEST', {}, { onlyIfNew: true })).modified, true);
    assert.equal((await admissions.setJSON('TYMF-TEST', {}, { onlyIfNew: true })).modified, false);
    assert.equal(requests[1].options.headers['if-none-match'], '*');
    assert.ok(requests.every(r => r.url.startsWith('https://blobs.example.invalid/')));
  } finally {
    global.fetch = originalFetch;
    if (originalContext === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT;
    else process.env.NETLIFY_BLOBS_CONTEXT = originalContext;
  }
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


test('first purchase sends tickets even when storage reads lag successful writes', async () => {
  const f = fixture(); f.state.staleReads = true;
  assert.equal((await f.issue()).statusCode, 200);
  assert.equal(f.sent[0].mail.attachments.length, 2);
  assert.equal(f.db.get('orders').size, 1);
  assert.equal(f.db.get('tickets').size, 2);
  f.state.staleReads = false;
  assert.equal((await f.scan(f.payloads[0])).status, 'ok');
  assert.equal((await f.issue()).statusCode, 200);
  assert.equal(f.sent.length, 2);
});

test('a conflicting existing order is never overwritten or emailed', async () => {
  const f = fixture();
  await f.getStore('orders').setJSON('TYMF-ABCDEFGH', { session: 'another-session', qty: 2 });
  assert.equal((await f.issue()).statusCode, 500);
  assert.equal(f.sent.length, 0);
  f.state.staleReads = true;
  assert.equal((await f.issue()).statusCode, 500);
  assert.equal(f.sent.length, 0);
  assert.equal(f.db.get('orders').get('TYMF-ABCDEFGH').session, 'another-session');
});

test('existing ticket conflicts prevent sending invalid admissions', async () => {
  const f = fixture();
  const { codesFor } = require('../netlify/lib/tickets');
  await f.getStore('tickets').setJSON(codesFor(f.session.id, 2)[0], { orderCode: 'another-order', index: 1 });
  assert.equal((await f.issue()).statusCode, 500);
  assert.equal(f.sent.length, 0);
});


test('referred checkout keeps commission metadata without creating a Connect split', async () => {
  let params;
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../netlify/functions/create-checkout.js'), 'utf8'), {
    exports: mod.exports, module: mod, process: { env: { STRIPE_SECRET_KEY: 'fixture' } },
    require: id => { assert.equal(id, 'stripe'); return () => ({ checkout: { sessions: { create: async p => { params=p; return { url: 'https://checkout.example.invalid' }; } } } }); }
  });
  const result=await mod.exports.handler({ httpMethod: 'POST', headers: { origin: 'https://example.invalid' }, body: JSON.stringify({ quantity: 2, ref: 'host' }) });
  assert.equal(result.statusCode, 200);
  assert.equal(params.metadata.ref, 'host');
  assert.equal(params.allow_promotion_codes, true);
  assert.equal(params.line_items[0].price_data.unit_amount, 20000);
  assert.equal(params.metadata.quantity, '2');
  assert.equal(params.metadata.connect, '');
  assert.equal(params.payment_intent_data, undefined);
});

test('discount quote validates Stripe code and checkout applies it without stacking discounts', async () => {
  let params, creates = 0, active = true;
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../netlify/functions/create-checkout.js'), 'utf8'), {
    exports: mod.exports, module: mod, process: { env: { STRIPE_SECRET_KEY: 'fixture' } },
    require: () => () => ({
      promotionCodes: { list: async ({code}) => ({ data: active && code === 'TYMF50' ? [{id:'promo_fixture',coupon:{valid:true,percent_off:50},restrictions:{}}] : [] }) },
      checkout: { sessions: { create: async p => { creates++; params=p; return {url:'https://checkout.example.invalid'}; } } }
    })
  });
  const request = body => mod.exports.handler({httpMethod:'POST',headers:{origin:'https://example.invalid'},body:JSON.stringify(body)});
  let result = await request({action:'quote',promoCode:' tymf50 ',quantity:2});
  assert.equal(result.statusCode,200);
  assert.equal(JSON.parse(result.body).percentOff,50);
  assert.equal(creates,0);
  result = await request({promoCode:'TYMF50',quantity:2,percentOff:100,unit_amount:1});
  assert.equal(result.statusCode,200);
  assert.equal(params.discounts[0].promotion_code,'promo_fixture');
  assert.equal(params.allow_promotion_codes,undefined);
  assert.equal(params.line_items[0].price_data.unit_amount,20000);
  assert.equal(params.line_items[0].quantity,2);
  active=false;
  assert.equal((await request({promoCode:'TYMF50'})).statusCode,400);
  assert.equal((await request({action:'quote',promoCode:'FAKE'})).statusCode,400);
  assert.equal(creates,1);
});

test('free registrations issue individual tickets, record zero revenue and commission, and retry safely', async () => {
  const f=fixture(2);
  f.session.payment_status='no_payment_required';
  f.session.amount_total=0;
  assert.equal((await f.issue()).statusCode,200);
  const order=[...f.db.get('orders').values()][0];
  assert.equal(order.amount,0);
  assert.equal(order.commission,0);
  assert.equal(order.ticketCodes.length,2);
  assert.equal(f.sent[0].mail.attachments.length,2);
  assert.equal((await f.scan(order.ticketCodes[0])).status,'ok');
  assert.equal((await f.scan(order.ticketCodes[0])).status,'used');
  const sent=f.sent.length;
  await f.issue();
  assert.equal(f.sent.length,sent);
  assert.equal((await f.report()).totals.revenue,0);
});

test('unpaid orders and nonzero no-payment-required sessions never issue tickets', async () => {
  for (const status of ['unpaid','no_payment_required']) {
    const f=fixture(); f.session.payment_status=status;
    await f.issue(); assert.equal(f.sent.length,0);
  }
});

test('all five complimentary codes validate and attach their Stripe promotion to checkout', async () => {
  const codes=['GUEST0','PARTNER0','SPONSOR0','ARTIST0','FACILITATOR0'];
  let params;
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../netlify/functions/create-checkout.js'),'utf8'),{
    exports:mod.exports,module:mod,process:{env:{STRIPE_SECRET_KEY:'fixture'}},
    require:()=>()=>({promotionCodes:{list:async({code})=>({data:codes.includes(code)?[{id:'promo_'+code,coupon:{valid:true,percent_off:100},restrictions:{}}]:[]})},checkout:{sessions:{create:async p=>{params=p;return {url:'https://checkout.example.invalid'};}}}})
  });
  const request=body=>mod.exports.handler({httpMethod:'POST',headers:{origin:'https://example.invalid'},body:JSON.stringify(body)});
  for(const code of codes){
    const quote=await request({action:'quote',promoCode:code.toLowerCase(),quantity:2});
    assert.equal(quote.statusCode,200);assert.equal(JSON.parse(quote.body).percentOff,100);
    assert.equal((await request({promoCode:code,quantity:2})).statusCode,200);
    assert.equal(params.discounts[0].promotion_code,'promo_'+code);
    assert.equal(params.allow_promotion_codes,undefined);
    assert.equal(params.metadata.quantity,'2');
  }
});
