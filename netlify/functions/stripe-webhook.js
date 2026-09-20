// Stripe webhook — fires after a successful checkout.
// Verifies the signature, generates a QR ticket, and emails it to the buyer.
//
// Required env vars (Netlify → Environment variables):
//   STRIPE_SECRET_KEY      sk_live_… (or sk_test_…)
//   STRIPE_WEBHOOK_SECRET  whsec_…  (from the webhook endpoint you create in Stripe)
//   RESEND_API_KEY         re_…     (from resend.com)
//   TICKET_FROM_EMAIL      e.g. "Tulum Yoga Music Fest <tickets@yogamusicfest.mx>"
//                          (must be on a domain you verified in Resend)

const Stripe = require('stripe');
const QRCode = require('qrcode');
const { Resend } = require('resend');
const { connectLambda } = require('@netlify/blobs');
const { store, codesFor } = require('../lib/tickets');

const COPY = {
  en: {
    subject: 'Your Tulum Yoga Music Fest ticket 🪷',
    preheader: 'Show this QR at the entrance.',
    hi: 'You\'re in!',
    intro: 'Your ticket to Tulum Yoga Music Fest is confirmed. We come together on:',
    when: 'Saturday, September 26, 2026',
    time: '11 AM – 11 PM · Oasis Tulum · La Veleta',
    admits: (n) => 'Admits ' + n + (n > 1 ? ' people' : ' person'),
    codeLabel: 'Ticket code',
    show: 'Show this QR code at the entrance. It\'s also attached to this email.',
    footer: 'Tulum Yoga Music Fest + Conference Week · September 21–27, 2026 · Tulum, México',
    ig: 'Instagram @yogamusicfest.mx',
  },
  es: {
    subject: 'Tu boleto para Tulum Yoga Music Fest 🪷',
    preheader: 'Muestra este QR en la entrada.',
    hi: '¡Estás dentro!',
    intro: 'Tu boleto para Tulum Yoga Music Fest está confirmado. Nos reunimos el:',
    when: 'Sábado, 26 de Septiembre, 2026',
    time: '11 AM – 11 PM · Oasis Tulum · La Veleta',
    admits: (n) => 'Admite ' + n + (n > 1 ? ' personas' : ' persona'),
    codeLabel: 'Código de boleto',
    show: 'Muestra este código QR en la entrada. También va adjunto a este correo.',
    footer: 'Tulum Yoga Music Fest + Semana de Conferencias · 21–27 de Septiembre, 2026 · Tulum, México',
    ig: 'Instagram @yogamusicfest.mx',
  },
};

function ticketHtml(t, code, qty, qrUrl, label = '') {
  return `<!doctype html><html><body style="margin:0;background:#0a0d0a;font-family:Georgia,'Times New Roman',serif;color:#efe8d6">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0">${t.preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d0a;padding:28px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#10160f;border:1px solid rgba(201,164,78,.28);border-radius:14px;overflow:hidden">
        <tr><td style="padding:28px 32px 8px;text-align:center">
          <div style="font-family:Georgia,serif;letter-spacing:6px;font-size:22px;font-weight:bold;color:#e6c884">T Y M F</div>
          <div style="letter-spacing:4px;font-size:11px;color:#8a9a6e;margin-top:4px">TULUM · 2026</div>
        </td></tr>
        <tr><td style="padding:8px 32px 0;text-align:center">
          <h1 style="font-family:Georgia,serif;color:#f4eeda;font-size:26px;margin:14px 0 6px">${t.hi}</h1>
          <p style="color:#aeb09a;font-size:15px;line-height:1.6;margin:0 0 14px">${t.intro}</p>
          <div style="font-family:Georgia,serif;color:#e6c884;font-size:20px">${t.when}</div>
          <div style="color:#aeb09a;font-size:13px;letter-spacing:1px;margin-top:4px">${t.time}</div>
          <div style="display:inline-block;margin:16px 0 6px;padding:6px 16px;border:1px solid rgba(201,164,78,.4);border-radius:100px;color:#e6c884;font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase">${label ? label + ' · ' : ''}${t.admits(qty)}</div>
        </td></tr>
        <tr><td align="center" style="padding:14px 32px 4px">
          <img src="${qrUrl}" width="220" height="220" alt="Ticket QR" style="display:block;background:#fff;border-radius:10px;padding:10px" />
        </td></tr>
        <tr><td style="padding:6px 32px 4px;text-align:center">
          <div style="font-family:Arial,sans-serif;font-size:10px;letter-spacing:2px;color:#8a9a6e;text-transform:uppercase">${t.codeLabel}</div>
          <div style="font-family:'Courier New',monospace;font-size:18px;letter-spacing:3px;color:#f4eeda;margin-top:4px">${code}</div>
          <p style="color:#aeb09a;font-size:12px;line-height:1.6;margin:16px auto 6px;max-width:360px">${t.show}</p>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;border-top:1px solid rgba(201,164,78,.16);text-align:center">
          <p style="color:#8a9a6e;font-size:11px;line-height:1.6;margin:0">${t.footer}<br/>${t.ig}</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function adminHtml(d) {
  const row = (k, v) =>
    '<tr><td style="padding:7px 16px 7px 0;color:#8a9a6e;font:12px Arial,sans-serif;white-space:nowrap;vertical-align:top">' + k +
    '</td><td style="padding:7px 0;color:#f4eeda;font:14px Arial,sans-serif">' + (esc(v) || '—') + '</td></tr>';
  return '<div style="background:#0a0d0a;padding:24px;font-family:Arial,sans-serif">' +
    '<div style="max-width:480px;margin:0 auto;background:#10160f;border:1px solid rgba(201,164,78,.28);border-radius:12px;padding:24px 28px">' +
    '<div style="color:#e6c884;font:bold 12px Arial;letter-spacing:2px;text-transform:uppercase">TYMF 2026 · New order</div>' +
    '<h2 style="color:#f4eeda;font:600 20px Georgia,serif;margin:8px 0 18px">' + esc(d.amount) + ' · ' + d.qty + ' ticket' + (d.qty > 1 ? 's' : '') + '</h2>' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' +
    row('Order code', d.code) + row('Tickets', d.qty) + row('Amount', d.amount) +
    row('Name', d.name) + row('Email', d.email) + row('Phone', d.phone) +
    row('Stripe session', d.sid) +
    '</table>' +
    '<p style="color:#8a9a6e;font:12px Arial;margin-top:18px">Full details are in your Stripe dashboard.</p>' +
    '</div></div>';
}

exports.handler = async (event) => {
  const key = process.env.STRIPE_SECRET_KEY;
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !whsec) return { statusCode: 500, body: 'Stripe not configured' };
  const stripe = Stripe(key);

  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, whsec);
  } catch (err) {
    return { statusCode: 400, body: 'Signature verification failed: ' + err.message };
  }

  // Acknowledge everything else so Stripe doesn't retry.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'ignored' };
  }

  const session = stripeEvent.data.object;
  if (session.payment_status !== 'paid') return { statusCode: 200, body: 'not paid' };

  const email =
    (session.customer_details && session.customer_details.email) || session.customer_email;
  const qty = Number((session.metadata && session.metadata.quantity) || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { statusCode: 400, body: 'Invalid ticket quantity' };
  const locale = (session.metadata && session.metadata.locale) === 'es' ? 'es' : 'en';
  const code = 'TYMF-' + String(session.id).replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();
  const t = COPY[locale];

  if (!email) return { statusCode: 200, body: 'no email on session' };

  // One immutable financial order, with separate admission codes. Retried
  // webhooks must not overwrite a used order or create additional admissions.
  let order;
  try {
    connectLambda(event);
    const ref = (session.metadata && session.metadata.ref) || '';
    const orders = store('orders');
    order = await orders.get(code, { type: 'json' });
    if (!order) {
      const newOrder = {
      code,
      qty,
      name: (session.customer_details && session.customer_details.name) || '',
      email,
      phone: (session.customer_details && session.customer_details.phone) || '',
      amount: session.amount_total,
      currency: session.currency,
      ref,
      // Half of the actual payment, in pesos; discounts reduce commissions too.
      commission: ref ? Math.round((session.amount_total || 0) / 2) / 100 : 0,
      autoPaid: (session.metadata && session.metadata.connect === '1') || false,
      session: session.id,
      liveMode: !!session.livemode,
      createdAt: new Date().toISOString(),
      used: false,
      usedAt: null,
      ticketCodes: codesFor(session.id, qty),
      };
      const created = await orders.setJSON(code, newOrder, { onlyIfNew: true });
      // A successful atomic write is authoritative. Reading the same key again
      // can return a cached miss from the lookup before the write.
      order = created.modified ? newOrder : await orders.get(code, { type: 'json' });
    }
    if (!order) throw new Error('Existing order not yet readable');
    if (order.session !== session.id || order.qty !== qty) throw new Error('Order mismatch');
    if (order.ticketCodes) {
      for (let i = 0; i < order.ticketCodes.length; i++) {
        const ticketCode = order.ticketCodes[i];
        const tickets = store('tickets');
        const newTicket = { code: ticketCode, orderCode: code, index: i + 1 };
        const created = await tickets.setJSON(ticketCode, newTicket, { onlyIfNew: true });
        const ticket = created.modified ? newTicket : await tickets.get(ticketCode, { type: 'json' });
        if (!ticket) throw new Error('Existing ticket not yet readable');
        if (ticket.orderCode !== code || ticket.index !== i + 1) throw new Error('Ticket mismatch');
      }
    }
  } catch (e) {
    console.log('Order store failed:', e && e.message);
    return { statusCode: 500, body: 'Ticket storage failed; retry required' };
  }

  if (!process.env.RESEND_API_KEY) return { statusCode: 500, body: 'RESEND_API_KEY not set' };

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.TICKET_FROM_EMAIL || 'Tulum Yoga Music Fest <onboarding@resend.dev>';

  // 1) Buyer's QR ticket — critical. On failure, 500 so Stripe retries.
  try {
    const deliveryKey = 'buyer-' + session.id;
    if (await store('ticket-delivery').get(deliveryKey, { type: 'json' })) {
      return { statusCode: 200, body: 'tickets already sent' };
    }
    const ticketCodes = order.ticketCodes || [code]; // Preserve previously issued shared tickets.
    const attachments = [];
    const cards = [];
    for (let i = 0; i < ticketCodes.length; i++) {
      const admissionCount = order.ticketCodes ? 1 : qty;
      const payload = 'TYMF2026|' + ticketCodes[i] + '|x' + admissionCount;
      const qrPng = await QRCode.toBuffer(payload, { margin: 1, width: 480,
        color: { dark: '#0a0d0a', light: '#ffffff' } });
      const qrUrl = (process.env.SITE_URL || 'https://yogamusicfest.mx') +
        '/.netlify/functions/qr?d=' + encodeURIComponent(payload);
      const label = (locale === 'es' ? 'Boleto ' : 'Ticket ') + (i + 1) + ' / ' + ticketCodes.length;
      cards.push(ticketHtml(t, ticketCodes[i], admissionCount, qrUrl, label)
        .replace(/^.*?<body[^>]*>/s, '').replace(/<\/body><\/html>$/, ''));
      attachments.push({ filename: 'tymf-2026-ticket-' + (i + 1) + '-of-' + ticketCodes.length + '.png', content: qrPng });
    }
    const explanation = locale === 'es'
      ? 'Cada boleto admite a una persona. Comparte un archivo adjunto diferente con cada acompañante; pueden llegar por separado.'
      : 'Each ticket admits one person. Share a different attachment with each guest; you can arrive separately.';
    const result = await resend.emails.send({
      from,
      to: email,
      subject: t.subject,
      html: '<!doctype html><html><body style="margin:0;background:#0a0d0a;color:#efe8d6">' +
        (order.ticketCodes ? '<p style="padding:24px;text-align:center;font:16px Arial">' + explanation + '</p>' : '') +
        cards.join('') + '</body></html>',
      attachments,
    }, { idempotencyKey: deliveryKey });
    if (result.error || !result.data || !result.data.id) throw new Error('Email provider did not accept tickets');
    await store('ticket-delivery').setJSON(deliveryKey, { emailId: result.data.id }, { onlyIfNew: true });
  } catch (err) {
    return { statusCode: 500, body: 'Ticket email failed: ' + (err.message || 'unknown') };
  }

  // 2) Organizer notification — best effort; never blocks/retries the buyer ticket.
  try {
    const cust = session.customer_details || {};
    const amount =
      '$' + ((session.amount_total || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) +
      ' ' + (session.currency || 'mxn').toUpperCase();
    await resend.emails.send({
      from,
      to: process.env.ADMIN_EMAIL || 'yogamusicfest.mx@gmail.com',
      subject: 'New ticket order — ' + qty + ' x TYMF 2026 (' + amount + ')',
      html: adminHtml({ code, qty, amount, name: cust.name, email: cust.email, phone: cust.phone, sid: session.id }),
    });
  } catch (e) {
    console.log('Admin notification failed:', e && e.message);
  }

  return { statusCode: 200, body: 'ticket sent' };
};
