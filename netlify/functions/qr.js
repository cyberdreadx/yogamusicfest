// Returns a QR code PNG for ?d=<payload>. Used as the inline ticket image
// in the ticket email (hosted image URLs render more reliably than cid: in Gmail).

const QRCode = require('qrcode');

exports.handler = async (event) => {
  const d = (event.queryStringParameters && event.queryStringParameters.d) || 'TYMF2026';
  try {
    const png = await QRCode.toBuffer(String(d).slice(0, 240), {
      margin: 1,
      width: 480,
      color: { dark: '#0a0d0a', light: '#ffffff' },
    });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      body: png.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 500, body: 'qr error' };
  }
};
