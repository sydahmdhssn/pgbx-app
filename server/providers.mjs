// External providers behind small adapters. Each has a test mode for development that must be switched on
// explicitly, so a misconfigured production server can never accept fake logins, payments or identity checks.
//
//   SMS login codes   Twilio Verify       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID   (test: OTP_TEST_MODE=1, code 123456)
//   Human check       Cloudflare Turnstile TURNSTILE_SITE_KEY, TURNSTILE_SECRET                              (optional; skipped when unset)
//   Payments          PAYMENT_PROVIDER + PAYMENT_WEBHOOK_SECRET (HMAC-SHA256 signed webhooks)                 (test: PAYMENT_PROVIDER=sandbox)
//   Identity checks   KYC_PROVIDER + KYC_WEBHOOK_SECRET                                                       (test: KYC_PROVIDER=sandbox)
//   Push              Firebase Cloud Messaging (Android and iOS) FCM_SERVICE_ACCOUNT (JSON)                    (unset: notifications stay in the app)
import crypto from 'node:crypto';

const env = k => process.env[k] || '';

async function fetchJson(url, opts = {}, ms = 10000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: d };
  } finally { clearTimeout(t); }
}

// ---------- SMS login codes ----------
const TWILIO_ERRORS = {
  20404: 'This code has expired or was already used. Request a new code.',
  60200: 'That number can’t receive codes. Check it and try again.',
  60202: 'Too many wrong codes. Request a new code.',
  60203: 'Too many codes sent to this number. Try again in 10 minutes.',
  60205: 'This number can’t receive SMS. Use a mobile number.',
  60410: 'Codes to this number are temporarily blocked. Contact PGBX support.',
};
export const otp = {
  get mode() { return env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_VERIFY_SERVICE_SID') ? 'twilio' : env('OTP_TEST_MODE') === '1' ? 'test' : 'off'; },
  channels() { return this.mode === 'twilio' ? ['sms', ...(env('OTP_WHATSAPP') === '1' ? ['whatsapp'] : [])] : this.mode === 'test' ? ['sms'] : []; },
  async twilio(path, form) {
    const auth = Buffer.from(`${env('TWILIO_ACCOUNT_SID')}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64');
    const r = await fetchJson(`https://verify.twilio.com/v2/Services/${env('TWILIO_VERIFY_SERVICE_SID')}/${path}`, {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
    });
    if (!r.ok) { const e = new Error(TWILIO_ERRORS[r.data.code] || 'We couldn’t reach the SMS service. Try again.'); e.status = r.status === 429 ? 429 : 400; e.expose = true; throw e; }
    return r.data;
  },
  async send(phone, channel = 'sms') {
    if (this.mode === 'test') return { channel };
    if (this.mode !== 'twilio') { const e = new Error('Login codes aren’t available right now. Please try again later.'); e.status = 503; e.expose = true; throw e; }
    const d = await this.twilio('Verifications', { To: '+92' + phone, Channel: channel === 'whatsapp' ? 'whatsapp' : 'sms', Locale: 'en' });
    return { channel: d.channel || channel };
  },
  async check(phone, code) {
    if (this.mode === 'test') return code === '123456';
    if (this.mode !== 'twilio') return false;
    const d = await this.twilio('VerificationCheck', { To: '+92' + phone, Code: code });
    return d.status === 'approved';
  },
};

// ---------- human check before sending codes ----------
export const turnstile = {
  get siteKey() { return env('TURNSTILE_SITE_KEY') || null; },
  get enabled() { return !!env('TURNSTILE_SECRET'); },
  async verify(token, ip) {
    if (!this.enabled) return true;
    if (!token) return false;
    const r = await fetchJson('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env('TURNSTILE_SECRET'), response: token, remoteip: ip || '' }),
    }, 8000).catch(() => ({ data: {} }));
    return r.data && r.data.success === true;
  },
};

// ---------- payments ----------
// A real provider integration implements createIntent() (returns what the app needs to open the payment page) and
// posts signed results to /api/v1/payments/webhook. The sandbox lets development and tests complete payments directly.
export const payments = {
  get provider() { return env('PAYMENT_PROVIDER') || null; },
  get sandbox() { return this.provider === 'sandbox'; },
  get webhookSecret() { return env('PAYMENT_WEBHOOK_SECRET') || null; },
  async createIntent(order) {
    if (this.sandbox) return { provider: 'sandbox', ref: 'sbx-' + order.id, action: { type: 'sandbox' } };
    if (!this.provider) { const e = new Error('Payments aren’t available yet.'); e.status = 503; e.expose = true; throw e; }
    // Provider-specific: create the payment with the provider and return its redirect or SDK token.
    const e = new Error(`Payment provider "${this.provider}" is not implemented yet.`); e.status = 503; e.expose = true; throw e;
  },
};

// ---------- identity verification ----------
export const kyc = {
  get provider() { return env('KYC_PROVIDER') || null; },
  get sandbox() { return this.provider === 'sandbox'; },
  get webhookSecret() { return env('KYC_WEBHOOK_SECRET') || null; },
  // Sandbox decision rules for testing: names containing "review" go to manual review, "fail" fail, everything else passes.
  async decide({ name }) {
    if (!this.sandbox) return { status: 'submitted' };      // a real provider answers later through the webhook
    const n = String(name || '').toLowerCase();
    if (n.includes('review')) return { status: 'review', reason: 'Selfie match needs a person to check (sandbox)' };
    if (n.includes('fail')) return { status: 'failed', reason: 'Details did not match the CNIC record (sandbox)' };
    return { status: 'passed' };
  },
};

// ---------- push notifications (FCM HTTP v1; FCM also delivers to iOS through APNs) ----------
let fcmToken = null;
async function fcmAccessToken(sa) {
  if (fcmToken && fcmToken.exp > Date.now() + 60000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error('FCM auth failed');
  fcmToken = { value: r.data.access_token, exp: Date.now() + r.data.expires_in * 1000 };
  return fcmToken.value;
}
export const push = {
  get enabled() { return !!env('FCM_SERVICE_ACCOUNT'); },
  async send(token, { title, body, link }) {
    const sa = JSON.parse(env('FCM_SERVICE_ACCOUNT'));
    const access = await fcmAccessToken(sa);
    const r = await fetchJson(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title, body }, data: { link: link ? JSON.stringify(link) : '' } } }),
    });
    return { ok: r.ok, gone: r.status === 404 || (r.data.error && r.data.error.status === 'UNREGISTERED') };
  },
};
