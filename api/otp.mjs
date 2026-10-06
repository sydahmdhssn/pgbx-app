import { ALLOWED_ORIGIN, allowOrigin } from './_origin.mjs';

// /api/otp: send and check one-time login codes by SMS or WhatsApp (FR-A1).
//
// Provider: Twilio Verify (it generates, sends, expires and checks the code; the code never reaches this server).
// Secrets live only in Vercel environment variables, never in the app (Rule 6):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_DEMO_VERIFY_SERVICE_SID (a separate Verify service, never production's)
//   OTP_WHATSAPP=1   set only after a WhatsApp Business sender is connected to the Verify service
//
//   GET  /api/otp                                   -> { configured, channels }
//   POST /api/otp { action: 'send',  phone, channel } -> { ok, channel }
//   POST /api/otp { action: 'check', phone, code }    -> { ok, approved }
// `phone` is the 10-digit national mobile number without the leading 0 (e.g. 3001234567).

// The demo uses its own Verify service, so it can never consume or send production login codes.
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_DEMO_VERIFY_SERVICE_SID: SERVICE } = process.env;
// This endpoint only serves the demo app. Its limits live in one server instance's memory, so a determined script
// could still run up SMS costs ("SMS pumping"). It therefore stays off unless OTP_DEMO_SMS=1 is also set. The
// production app uses /api/v1/auth/otp/*, which has the human check and database-backed limits.
const CONFIGURED = Boolean(SID && TOKEN && SERVICE && process.env.OTP_DEMO_SMS === '1');
const CHANNELS = ['sms', ...(process.env.OTP_WHATSAPP === '1' ? ['whatsapp'] : [])];

// Pakistani mobile numbers: Jazz 300–309 and 320–329, Zong 310–319, Ufone 330–339, Telenor 340–349, SCOM 355
const PK_MOBILE = /^3(?:[0-4]\d|55)\d{7}$/;

// Abuse limits (best effort, kept in this server instance's memory; Twilio Verify adds its own limits and Fraud Guard).
// The durable fix (shared rate-limit store + human check before sending) is planned; see README.
const RESEND_MS = 30000;                         // one code per number every 30 s
const LIMITS = {
  sendPerNumber: { max: 3, ms: 60 * 60e3 },      // 3 codes per number per hour
  sendPerIp: { max: 5, ms: 10 * 60e3 },          // 5 codes per device / IP per 10 minutes
  checkPerIp: { max: 20, ms: 10 * 60e3 },        // 20 code checks per device / IP per 10 minutes
};
const lastSend = new Map();
const hits = new Map();
function limited(kind, key) {
  const { max, ms } = LIMITS[kind]; const k = kind + ':' + key; const now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < ms);
  if (arr.length >= max) { hits.set(k, arr); return Math.ceil((ms - (now - arr[0])) / 1000); }
  arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) for (const [key2, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(key2);
  return 0;
}
const clientIp = req => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';


const ERRORS = {
  20404: ['expired', 'This code has expired or was already used. Request a new code.'],
  60200: ['invalid', 'That number cannot receive codes. Check it and try again.'],
  60202: ['too_many_checks', 'Too many wrong codes. Request a new code.'],
  60203: ['too_many_sends', 'Too many codes sent to this number. Try again in 10 minutes.'],
  60205: ['not_mobile', 'This number cannot receive SMS. Use a mobile number.'],
  60410: ['blocked', 'Codes to this number are temporarily blocked. Contact PGBX support.'],
  60605: ['blocked', 'Sending codes to this country is not enabled.'],
  68008: ['whatsapp_unavailable', 'WhatsApp codes are not set up yet. Use SMS.'],
};

async function twilio(path, form) {
  const r = await fetch(`https://verify.twilio.com/v2/Services/${SERVICE}/${path}`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.message || `Twilio HTTP ${r.status}`); e.code = d.code; e.status = r.status; throw e; }
  return d;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2000) break; }
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const origin = allowOrigin(req, res, 'GET, POST');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method === 'GET') return send(res, 200, { ok: true, configured: CONFIGURED, channels: CONFIGURED ? CHANNELS : [] });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
  // Only the app's own pages may ask for codes: browsers always send Origin on these POSTs. (A script can fake the
  // header, so this only stops casual misuse; the per-IP and per-number limits below and Twilio's limits do the rest.)
  if (!origin || !ALLOWED_ORIGIN.test(origin)) return send(res, 403, { ok: false, error: 'origin' });
  if (!String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { ok: false, error: 'content_type' });
  if (!CONFIGURED) return send(res, 503, { ok: false, configured: false, error: 'not_configured', message: 'SMS provider is not connected yet.' });

  const body = await readBody(req);
  const phone = String(body.phone || '').replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  if (!PK_MOBILE.test(phone)) return send(res, 400, { ok: false, error: 'invalid_number', message: 'Enter a valid Pakistani mobile number, for example 300 1234567.' });
  const to = '+92' + phone;

  try {
    if (body.action === 'send') {
      const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'sms';
      if (!CHANNELS.includes(channel)) return send(res, 400, { ok: false, error: 'whatsapp_unavailable', message: ERRORS[68008][1] });
      const last = lastSend.get(to) || 0;
      if (Date.now() - last < RESEND_MS) return send(res, 429, { ok: false, error: 'wait', retryIn: Math.ceil((RESEND_MS - (Date.now() - last)) / 1000), message: 'Please wait before requesting another code.' });
      const ipWait = limited('sendPerIp', clientIp(req));
      if (ipWait) return send(res, 429, { ok: false, error: 'wait', retryIn: ipWait, message: 'Too many codes requested from this device. Try again later.' });
      const numWait = limited('sendPerNumber', to);
      if (numWait) return send(res, 429, { ok: false, error: 'wait', retryIn: numWait, message: 'Too many codes sent to this number. Try again later.' });
      lastSend.set(to, Date.now());
      if (lastSend.size > 5000) for (const [k, t] of lastSend) if (Date.now() - t > RESEND_MS) lastSend.delete(k);
      const v = await twilio('Verifications', { To: to, Channel: channel, Locale: 'en' });
      return send(res, 200, { ok: true, channel: v.channel || channel, status: v.status });
    }
    if (body.action === 'check') {
      const checkWait = limited('checkPerIp', clientIp(req));
      if (checkWait) return send(res, 429, { ok: false, error: 'wait', retryIn: checkWait, message: 'Too many attempts from this device. Try again later.' });
      const code = String(body.code || '').replace(/\D/g, '');
      if (code.length < 4 || code.length > 10) return send(res, 400, { ok: false, error: 'invalid_code', message: 'Enter the code you received.' });
      const v = await twilio('VerificationCheck', { To: to, Code: code });
      // A production backend would now create the customer's session server-side (Rule 6, NFR-8).
      return send(res, 200, { ok: true, approved: v.status === 'approved', message: v.status === 'approved' ? undefined : 'That code is incorrect. Check the message and try again.' });
    }
    return send(res, 400, { ok: false, error: 'action' });
  } catch (e) {
    const [error, message] = ERRORS[e.code] || ['provider', 'Could not reach the SMS provider. Try again.'];
    return send(res, e.status === 429 ? 429 : 400, { ok: false, error, message, code: e.code });
  }
}
