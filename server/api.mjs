// PGBX API v1. A thin layer over the database functions in supabase/migrations: it authenticates, applies abuse
// limits, calls one SQL function per action and turns error codes into plain language. Deployed as api/v1.mjs.
//
//   Customers   Bearer token (native app) or HttpOnly cookie "pgbx_s" (web), created after an SMS code
//   Staff       password + authenticator code (TOTP); cookie "pgbx_staff"; roles admin, ops, dealer
//   Providers   signed webhooks (HMAC-SHA256)
//   Scheduler   GET /cron/sweep (expiry, purge, push; Vercel Cron) with "Authorization: Bearer $CRON_SECRET"
import { getDb } from './db.mjs';
import * as sec from './security.mjs';
import { otp, turnstile, payments, kyc, push } from './providers.mjs';
import { fetchLiveRates } from './rates.mjs';
import { ALLOWED_ORIGIN } from '../api/_origin.mjs';

const TOLA = 11.664;
const PK_MOBILE = /^3(?:[0-4]\d|55)\d{7}$/;

// Error codes from SQL (and the API) → status and plain-language message
const MESSAGES = {
  RATES_STALE: [409, 'Prices are updating. Try again in a few seconds.'],
  LOCK_EXPIRED: [409, 'The price lock ended. Check the new price and try again.'],
  LOCK_NOT_FOUND: [404, 'That price lock wasn’t found. Start again from the product.'],
  KYC_REQUIRED: [403, 'Verify your identity before buying or collecting.'],
  ACCOUNT_INACTIVE: [403, 'This account isn’t active. Contact PGBX support.'],
  ORDER_LIMIT: [400, 'That’s more than the number of bars allowed in one order.'],
  DAILY_LIMIT: [400, 'This order would take you over today’s purchase limit.'],
  MIN_PURCHASE: [400, 'This order is below the minimum purchase.'],
  NO_PRODUCTS: [400, 'Choose at least one product.'],
  UNKNOWN_PRODUCT: [400, 'One of those products isn’t available.'],
  PRODUCT_NOT_LOCKED: [400, 'One of those products wasn’t in your price lock. Start again from the product.'],
  BAD_UNITS: [400, 'Choose a whole number of bars.'],
  INSUFFICIENT_HOLDINGS: [409, 'You don’t have that many bars available to collect.'],
  OUT_OF_STOCK: [409, 'That dealer doesn’t have enough stock. Choose another dealer.'],
  DEALER_UNAVAILABLE: [409, 'That dealer isn’t available. Choose another dealer.'],
  REDEMPTION_NOT_ACTIVE: [409, 'This collection is no longer active.'],
  REDEMPTION_NOT_REQUESTED: [409, 'This collection isn’t waiting to be prepared.'],
  REDEMPTION_NOT_READY: [409, 'Mark the collection ready before handing it over.'],
  CODE_NOT_FOUND: [404, 'No active collection with that code at this dealer.'],
  CODE_EXPIRED: [410, 'This code has expired. The customer can reserve again.'],
  CNIC_NOT_CHECKED: [400, 'Confirm that the customer’s CNIC matches before handing over.'],
  SERIALS_REQUIRED: [400, 'Enter one different serial number for each bar handed over.'],
  NOT_A_DEALER: [403, 'This account can’t use the dealer tools.'],
  ORDER_NOT_FOUND: [404, 'Order not found.'],
  ORDER_NOT_FLAGGED: [409, 'Only orders waiting for operations can be resolved.'],
  BAD_ACTION: [400, 'Unknown action.'],
  // services
  CITY_NOT_SERVED: [400, 'PGBX doesn’t serve that city yet. Choose another city.'],
  BAD_SLOT: [400, 'Choose one of the available time slots.'],
  BAD_DATE: [400, 'Choose a date within the allowed range.'],
  NO_ITEMS: [400, 'Add at least one piece to be checked.'],
  BAD_ADDRESS: [400, 'Enter the full address, including house number and street.'],
  SLOT_FULL: [409, 'That time slot is fully booked. Choose another slot.'],
  NOT_FOUND: [404, 'Not found.'],
  CANNOT_CANCEL: [409, 'This can no longer be cancelled.'],
  BAD_GOLDSMITH: [400, 'Enter the goldsmith’s name and phone number.'],
  BAD_SHAPE: [400, 'That weight isn’t made in this shape.'],
  BAD_DESIGN: [400, 'Choose a design.'],
  BAD_PACKAGING: [400, 'Choose the packaging.'],
  ENGRAVING_TOO_LONG: [400, 'The engraving can be up to 24 characters.'],
  BAD_RECIPIENT: [400, 'Enter the recipient’s name, mobile number and full address.'],
  TRACKING_REQUIRED: [400, 'Enter the courier tracking number.'],
  AMOUNT_MISMATCH: [409, 'The amount paid doesn’t match. PGBX operations will check it.'],
};

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };

// ---------- routing ----------
const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}

// ---------- helpers ----------
const clientIp = req => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), parts.join('; ')]);
}
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return { raw: '', json: {} };
  let raw = '';
  if (typeof req.on === 'function' && !req.readableEnded) {
    for await (const chunk of req) { raw += chunk; if (raw.length > 65536) fail(413, 'TOO_LARGE', 'Request too large.'); }
  }
  if (!raw && req.body) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  if (!raw) return { raw: '', json: {} };
  try { return { raw, json: JSON.parse(raw) }; } catch { fail(400, 'BAD_JSON', 'The request couldn’t be read.'); }
}
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = v => (Number.isInteger(v) ? v : Number.isInteger(Number(v)) ? Number(v) : NaN);
async function limit(db, key, windowSec, max, message) {
  const r = await db.one(`select fn_rate_limit($1, $2, $3) as wait`, [key, windowSec, max]);
  if (r.wait > 0) fail(429, 'RATE_LIMITED', message || 'Too many attempts. Please wait and try again.', { retryIn: r.wait });
}
const audit = (db, actor, action, entity, id, data = {}) => db.query(`select audit($1, $2, $3, $4, $5::jsonb)`, [actor, action, entity, id, JSON.stringify(data)]);
const settingsMap = async db => Object.fromEntries((await db.query(`select key, value from settings`)).map(r => [r.key, r.value]));

// FR-R4: prices whose source timestamp is older than this are not recorded, so nothing can be locked at them.
const SOURCE_STALE_MS = 90000;
const sourceFresh = d => ['gold', 'silver'].every(k => { const t = Date.parse(d.metals[k] && d.metals[k].sourceUpdatedAt); return !Number.isFinite(t) || Date.now() - t <= SOURCE_STALE_MS; });

// Keep a recent rate snapshot: every price lock uses the server's own snapshot (Rule 1).
async function ensureRates(db, fetchRates) {
  const s = await db.one(`select *, extract(epoch from now() - fetched_at) as age from rate_snapshots order by id desc limit 1`);
  const stale = Number((await db.one(`select setting_int('rate_stale_seconds') as v`)).v);
  if (s && s.age < stale / 2) return s;
  const set = await settingsMap(db);
  const d = await fetchRates({ spread: set.spread || undefined }).catch(() => null);
  if (!d || !d.ok || !sourceFresh(d)) return s;              // the lock function refuses stale prices
  await db.one(`select fn_record_rates($1, $2, $3, $4, $5) as id`, [d.metals.gold.buyTola, d.metals.gold.sellTola, d.metals.silver.buyTola, d.metals.silver.sellTola, d.metals.gold.source || 'live']);
  return db.one(`select *, 0 as age from rate_snapshots order by id desc limit 1`);
}

// ---------- authentication ----------
async function customerFrom(ctx) {
  const { req, db } = ctx;
  const auth = String(req.headers.authorization || '');
  const viaCookie = !auth.startsWith('Bearer ');
  const token = viaCookie ? cookies(req).pgbx_s : auth.slice(7);
  if (!token) fail(401, 'SESSION_REQUIRED', 'Please log in.');
  if (viaCookie && req.method !== 'GET') sameOrigin(req);
  const s = await db.one(`select s.token_hash, c.* from sessions s join customers c on c.id = s.customer_id
    where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`, [sec.hashToken(token)]);
  if (!s) fail(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
  if (s.status !== 'active') fail(403, 'ACCOUNT_INACTIVE', MESSAGES.ACCOUNT_INACTIVE[1]);
  db.query(`update sessions set last_seen_at = now() where token_hash = $1 and last_seen_at < now() - interval '5 minutes'`, [s.token_hash]).catch(() => {});
  return s;
}
async function staffFrom(ctx, { preMfa = false, roles } = {}) {
  const { req, db } = ctx;
  const auth = String(req.headers.authorization || '');
  const viaCookie = !auth.startsWith('Bearer ');
  const token = viaCookie ? cookies(req).pgbx_staff : auth.slice(7);
  if (!token) fail(401, 'SESSION_REQUIRED', 'Please sign in.');
  if (viaCookie && req.method !== 'GET') sameOrigin(req);
  const s = await db.one(`select ss.token_hash, ss.mfa_passed, st.* from staff_sessions ss join staff st on st.id = ss.staff_id
    where ss.token_hash = $1 and ss.revoked_at is null and ss.expires_at > now() and st.active`, [sec.hashToken(token)]);
  if (!s) fail(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
  if (!preMfa && !s.mfa_passed) fail(401, 'MFA_REQUIRED', 'Enter the code from your authenticator app.');
  if (roles && !roles.includes(s.role)) fail(403, 'FORBIDDEN', 'Your role can’t do this.');
  return s;
}
// Cookie-authenticated changes must come from the app's own pages (with SameSite=Strict this blocks cross-site requests).
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin) return;                                        // non-browser clients send no Origin
  if (ALLOWED_ORIGIN.test(origin) || new URL(origin).host === host) return;
  fail(403, 'BAD_ORIGIN', 'Request blocked.');
}

// ---------- public ----------
const PUBLIC_SETTINGS = ['max_units_per_order', 'daily_limit_pkr', 'min_purchase_pkr', 'price_lock_seconds', 'rate_stale_seconds', 'redemption_valid_hours', 'redemption_fee_pkr', 'order_payment_minutes'];
route('GET', '/config', {}, async ({ db }) => ({
  live: !!db,
  otp: { mode: otp.mode, channels: otp.channels() },
  turnstileSiteKey: turnstile.siteKey,
  payments: { provider: payments.provider },
  kyc: { provider: kyc.provider },
  limits: db ? Object.fromEntries((await db.query(`select key, value from settings where key = any($1)`, [PUBLIC_SETTINGS])).map(r => [r.key, r.value])) : null,
}));

route('GET', '/products', {}, async ({ db, fetchRates }) => {
  await ensureRates(db, fetchRates).catch(() => {});
  const rows = await db.query(`select p.id, p.metal, p.label, p.grams::float8 as grams, p.premium_pkr,
      case when s.fetched_at > now() - make_interval(secs => setting_int('rate_stale_seconds')) then product_price(p, s) end as price_pkr
    from products p left join lateral (select * from rate_snapshots order by id desc limit 1) s on true where p.active order by p.sort`);
  return { products: rows };
});

// Live prices for the production app, priced with PGBX's own spread and premiums (the same inputs as a price lock).
// Each answer is also recorded as a rate snapshot (at most every 5 s), so what customers see is what they can lock.
route('GET', '/rates', {}, async ({ db, res, fetchRates }) => {
  const set = await settingsMap(db);
  const premiums = Object.fromEntries((await db.query(`select id, premium_pkr from products`)).map(r => [r.id, r.premium_pkr]));
  const d = await fetchRates({ spread: set.spread || undefined, premiums }).catch(() => null);
  if (!d || !d.ok) fail(502, 'RATES_DOWN', 'Live rates are unavailable right now.');
  if (!sourceFresh(d)) fail(502, 'RATES_STALE_SOURCE', 'Live rates are delayed right now. Buying is paused until they update.');
  const last = await db.one(`select extract(epoch from now() - fetched_at) as age from rate_snapshots order by id desc limit 1`);
  if (!last || last.age >= 5) await db.one(`select fn_record_rates($1, $2, $3, $4, $5) as id`, [d.metals.gold.buyTola, d.metals.gold.sellTola, d.metals.silver.buyTola, d.metals.silver.sellTola, d.metals.gold.source || 'live']);
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=10');
  return d;
});

// Units each dealer can hand over now, capped at 10 so exact stock levels stay private
route('GET', '/dealers', {}, async ({ db }) => {
  const rows = await db.query(`select d.id, d.name, d.area, d.address, d.phone, d.lat::float8 as lat, d.lng::float8 as lng, d.hours,
      coalesce((select json_object_agg(s.product_id, greatest(0, least(10, s.units - coalesce((select sum(units) from redemptions r
        where r.dealer_id = d.id and r.product_id = s.product_id and r.status in ('requested', 'ready') and r.expires_at > now()), 0))))
        from dealer_stock s where s.dealer_id = d.id), '{}') as available
    from dealers d where d.active order by d.name`);
  return { dealers: rows };
});

// ---------- customer login (FR-A1) ----------
route('POST', '/auth/otp/start', {}, async ({ db, body, req }) => {
  const phone = str(body.phone).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  if (!PK_MOBILE.test(phone)) fail(400, 'BAD_PHONE', 'Enter a valid Pakistani mobile number, for example 300 1234567.');
  if (!(await turnstile.verify(body.turnstileToken, clientIp(req)))) fail(400, 'HUMAN_CHECK', 'Please complete the check that you’re not a robot.');
  await limit(db, 'otp-send-30s:' + phone, 30, 1, 'Please wait a moment before requesting another code.');
  await limit(db, 'otp-send-h:' + phone, 3600, 3, 'Too many codes sent to this number. Try again later.');
  await limit(db, 'otp-send-ip:' + clientIp(req), 600, 5, 'Too many codes requested from this device. Try again later.');
  const r = await otp.send(phone, body.channel === 'whatsapp' && otp.channels().includes('whatsapp') ? 'whatsapp' : 'sms');
  return { ok: true, channel: r.channel, testMode: otp.mode === 'test' };
});

route('POST', '/auth/otp/verify', {}, async ({ db, body, req, res }) => {
  const phone = str(body.phone).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  const code = str(body.code).replace(/\D/g, '');
  if (!PK_MOBILE.test(phone) || code.length !== 6) fail(400, 'BAD_CODE', 'Enter the 6-digit code you received.');
  await limit(db, 'otp-check-ip:' + clientIp(req), 600, 20, 'Too many attempts from this device. Try again later.');
  await limit(db, 'otp-check-h:' + phone, 3600, 10, 'Too many wrong codes. Request a new code later.');
  if (!(await otp.check(phone, code))) fail(400, 'WRONG_CODE', 'That code is incorrect. Check the message and try again.');
  let c = await db.one(`select * from customers where phone = $1`, [phone]);
  const isNew = !c;
  if (!c) c = await db.one(`insert into customers (phone) values ($1) returning *`, [phone]);
  if (c.status !== 'active') fail(403, 'ACCOUNT_INACTIVE', MESSAGES.ACCOUNT_INACTIVE[1]);
  const token = sec.newToken();
  const days = Number((await db.one(`select setting_int('session_days') as d`)).d);
  await db.query(`insert into sessions (token_hash, customer_id, device, expires_at) values ($1, $2, $3, now() + make_interval(days => $4::int))`,
    [sec.hashToken(token), c.id, str(body.device, 120) || null, days]);
  await audit(db, 'customer:' + c.id, isNew ? 'account.created' : 'login', 'customer', c.id, { ip: clientIp(req) });
  if (!isNew) await db.query(`select notify_customer($1, 'security', 'New login', $2, null, true)`, [c.id, `Your account was opened on ${str(body.device, 60) || 'a device'}. If this wasn’t you, contact PGBX.`]);
  if (body.cookie !== false) setCookie(res, 'pgbx_s', token, days * 86400);
  return { token, customer: { id: c.id, isNew } };
});

route('POST', '/auth/logout', { auth: 'customer' }, async ({ db, customer, res }) => {
  await db.query(`update sessions set revoked_at = now() where token_hash = $1`, [customer.token_hash]);
  setCookie(res, 'pgbx_s', '', 0);
  return { ok: true };
});

// ---------- customer: profile and wallet ----------
async function walletOf(db, customerId) {
  const snap = await db.one(`select * from rate_snapshots order by id desc limit 1`);
  const rows = await db.query(`select h.product_id, h.units, reserved_of($1, h.product_id) as reserved, p.metal, p.label, p.grams::float8 as grams
    from v_holdings h join products p on p.id = h.product_id where h.customer_id = $1 order by p.sort`, [customerId]);
  const sell = m => (snap ? (m === 'gold' ? snap.gold_sell_tola : snap.silver_sell_tola) / TOLA : 0);
  const holdings = rows.map(r => ({ ...r, value_pkr: Math.round(r.units * r.grams * sell(r.metal)) }));
  return { holdings, total_value_pkr: holdings.reduce((a, h) => a + h.value_pkr, 0), priced_at: snap?.fetched_at || null };
}
route('GET', '/me', { auth: 'customer' }, async ({ db, customer }) => {
  const c = customer;
  return {
    profile: { id: c.id, phone: c.phone, name: c.name, cnic: c.cnic, dob: c.dob, email: c.email, address: c.address },
    kyc: { status: c.kyc_status, at: c.kyc_at },
    wallet: await walletOf(db, c.id),
    unread: (await db.one(`select count(*)::int n from notifications where customer_id = $1 and read_at is null`, [c.id])).n,
  };
});

route('PATCH', '/me', { auth: 'customer' }, async ({ db, customer, body }) => {
  const f = {};
  if ('name' in body) { f.name = str(body.name, 100); if (f.name.length < 3) fail(400, 'BAD_NAME', 'Enter your full name.'); }
  if ('cnic' in body) { f.cnic = str(body.cnic).replace(/\D/g, ''); if (f.cnic.length !== 13) fail(400, 'BAD_CNIC', 'Enter all 13 digits of your CNIC.'); f.cnic = `${f.cnic.slice(0, 5)}-${f.cnic.slice(5, 12)}-${f.cnic.slice(12)}`; }
  if ('dob' in body) { f.dob = str(body.dob, 10); const age = (Date.now() - Date.parse(f.dob)) / (365.25 * 864e5); if (!(age >= 18 && age < 120)) fail(400, 'BAD_DOB', 'You must be 18 or older.'); }
  if ('email' in body) { f.email = str(body.email, 200) || null; if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) fail(400, 'BAD_EMAIL', 'Enter a valid email address, for example name@example.com.'); }
  if ('address' in body) f.address = str(body.address, 300) || null;
  const keys = Object.keys(f);
  if (!keys.length) return { ok: true };
  const idChanged = ['name', 'cnic', 'dob'].some(k => k in f && String(f[k] ?? '') !== String(customer[k] instanceof Date ? customer[k].toISOString().slice(0, 10) : customer[k] ?? ''));
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (idChanged && customer.kyc_status === 'verified') sets.push(`kyc_status = 'reverify'`);
  await db.query(`update customers set ${sets.join(', ')} where id = $1`, [customer.id, ...keys.map(k => f[k])]);
  await audit(db, 'customer:' + customer.id, 'profile.updated', 'customer', customer.id, { fields: keys, reverify: idChanged && customer.kyc_status === 'verified' });
  return { ok: true, reverify: idChanged && customer.kyc_status === 'verified' };
});

route('POST', '/me/phone/start', { auth: 'customer' }, async ({ db, customer, body }) => {
  const phone = str(body.phone).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  if (!PK_MOBILE.test(phone)) fail(400, 'BAD_PHONE', 'Enter a valid Pakistani mobile number, for example 300 1234567.');
  if (await db.one(`select 1 from customers where phone = $1`, [phone])) fail(409, 'PHONE_IN_USE', 'That number is already used by another PGBX account.');
  await limit(db, 'phone-change:' + customer.id, 3600, 3, 'Too many attempts. Try again later.');
  await otp.send(phone, 'sms');
  return { ok: true };
});
route('POST', '/me/phone/verify', { auth: 'customer' }, async ({ db, customer, body }) => {
  const phone = str(body.phone).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  await limit(db, 'phone-check:' + customer.id, 3600, 10, 'Too many wrong codes. Try again later.');
  if (!(await otp.check(phone, str(body.code).replace(/\D/g, '')))) fail(400, 'WRONG_CODE', 'That code is incorrect. Check the SMS and try again.');
  await db.query(`update customers set phone = $2 where id = $1`, [customer.id, phone]);
  await audit(db, 'customer:' + customer.id, 'phone.changed', 'customer', customer.id, {});
  await db.query(`select notify_customer($1, 'security', 'Mobile number changed', $2, null, true)`, [customer.id, `Your account now uses +92 ${phone.slice(0, 3)} ${phone.slice(3)}. If this wasn’t you, contact PGBX.`]);
  return { ok: true };
});

route('POST', '/devices/push', { auth: 'customer' }, async ({ db, customer, body }) => {
  const token = str(body.token, 400); const platform = ['ios', 'android', 'web'].includes(body.platform) ? body.platform : null;
  if (!token || !platform) fail(400, 'BAD_TOKEN', 'Invalid device.');
  await db.query(`insert into push_tokens (token, customer_id, platform) values ($1, $2, $3)
    on conflict (token) do update set customer_id = excluded.customer_id, last_seen_at = now()`, [token, customer.id, platform]);
  return { ok: true };
});

// ---------- identity verification (FR-A2) ----------
route('POST', '/kyc', { auth: 'customer' }, async ({ db, customer }) => {
  if (!kyc.provider) fail(503, 'KYC_OFF', 'Identity verification isn’t available yet.');
  const k = await db.one(`insert into kyc_checks (customer_id, provider) values ($1, $2) returning id, status`, [customer.id, kyc.provider]);
  await db.query(`update customers set kyc_status = 'pending' where id = $1 and kyc_status in ('none', 'failed', 'reverify')`, [customer.id]);
  return { check: k };
});
route('POST', '/kyc/:id/submit', { auth: 'customer' }, async ({ db, customer, body, params }) => {
  const k = await db.one(`select * from kyc_checks where id = $1 and customer_id = $2 and status = 'started'`, [params.id, customer.id]);
  if (!k) fail(404, 'KYC_NOT_FOUND', 'Start identity verification again.');
  const cnic = str(body.cnic).replace(/\D/g, ''); const name = str(body.name, 100); const dob = str(body.dob, 10); const expiry = str(body.expiry, 10);
  if (cnic.length !== 13 || name.length < 3 || !dob || !(Date.parse(expiry) > Date.now())) fail(400, 'BAD_KYC', 'Check your CNIC details and try again.');
  const d = await kyc.decide({ name, cnic, dob });
  await db.query(`update kyc_checks set status = $2, reason = $3, data = $4::jsonb, decided_at = case when $2 in ('passed', 'failed') then now() end, decided_by = $5 where id = $1`,
    [k.id, d.status, d.reason || null, JSON.stringify({ expiry }), kyc.sandbox ? 'provider:sandbox' : null]);
  const status = { passed: 'verified', failed: 'failed', review: 'review', submitted: 'pending' }[d.status];
  await db.query(`update customers set name = $2, cnic = $3, dob = $4, kyc_status = $5, kyc_at = case when $5 = 'verified' then now() else kyc_at end where id = $1`,
    [customer.id, name, `${cnic.slice(0, 5)}-${cnic.slice(5, 12)}-${cnic.slice(12)}`, dob, status]);
  await audit(db, 'customer:' + customer.id, 'kyc.submitted', 'kyc', k.id, { result: d.status });
  return { status, reason: d.status === 'failed' ? 'We couldn’t verify these details. Check them against your CNIC and try again.' : d.status === 'review' ? 'A PGBX team member will review your check, usually within one working day.' : null };
});

// ---------- buying (FR-B1–B8) ----------
route('POST', '/locks', { auth: 'customer' }, async ({ db, customer, body, fetchRates }) => {
  const ids = Array.isArray(body.products) ? body.products.map(p => str(p, 40)).filter(Boolean).slice(0, 20) : [];
  await ensureRates(db, fetchRates);
  const l = await db.one(`select * from fn_create_lock($1, $2)`, [customer.id, ids]);
  return { lock: { id: l.id, prices: l.prices, expires_at: l.expires_at } };
});

route('POST', '/orders', { auth: 'customer' }, async ({ db, customer, body }) => {
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, 20).map(l => ({ product_id: str(l.productId || l.product_id, 40), units: int(l.units) })) : [];
  if (lines.some(l => !Number.isInteger(l.units))) fail(400, 'BAD_UNITS', MESSAGES.BAD_UNITS[1]);
  const method = ['bank', 'card', 'mwallet'].includes(body.method) ? body.method : fail(400, 'BAD_METHOD', 'Choose a payment method.');
  const key = str(body.idempotencyKey, 80); if (key.length < 8) fail(400, 'BAD_KEY', 'Missing request key.');
  if (!payments.provider) fail(503, 'PAYMENTS_OFF', 'Payments aren’t available yet.');
  const o = await db.one(`select * from fn_place_order($1, $2, $3::jsonb, $4, $5)`, [customer.id, str(body.lockId, 40), JSON.stringify(lines), method, key]);
  const payment = o.status === 'pending_payment' ? await payments.createIntent(o) : null;
  return { order: orderDto(o), payment };
});

const orderDto = o => ({ id: o.id, receipt_no: o.receipt_no, status: o.status, total_pkr: o.total_pkr, method: o.method, created_at: o.created_at, credited_at: o.credited_at, note: o.status === 'flagged' ? 'PGBX operations is completing this order.' : undefined });
route('GET', '/orders', { auth: 'customer' }, async ({ db, customer }) => {
  const rows = await db.query(`select o.*, (select json_agg(json_build_object('product_id', l.product_id, 'units', l.units, 'unit_price_pkr', l.unit_price_pkr)) from order_lines l where l.order_id = o.id) as lines
    from orders o where customer_id = $1 order by created_at desc limit 100`, [customer.id]);
  return { orders: rows.map(o => ({ ...orderDto(o), lines: o.lines })) };
});
route('GET', '/orders/:id', { auth: 'customer' }, async ({ db, customer, params }) => {
  const o = await db.one(`select * from orders where id = $1 and customer_id = $2`, [params.id, customer.id]);
  if (!o) fail(404, 'ORDER_NOT_FOUND', MESSAGES.ORDER_NOT_FOUND[1]);
  return { order: { ...orderDto(o), lines: await db.query(`select product_id, units, unit_price_pkr from order_lines where order_id = $1`, [o.id]) } };
});

// Sandbox only: completes a payment the way a provider webhook would. Disabled unless PAYMENT_PROVIDER=sandbox.
route('POST', '/payments/sandbox/:id', { auth: 'customer' }, async ({ db, customer, params, body }) => {
  if (!payments.sandbox) fail(404, 'NOT_FOUND', 'Not found.');
  const o = await db.one(`select * from orders where id = $1 and customer_id = $2`, [params.id, customer.id]);
  if (!o) fail(404, 'ORDER_NOT_FOUND', MESSAGES.ORDER_NOT_FOUND[1]);
  const r = body.outcome === 'fail'
    ? await db.one(`select * from fn_payment_failed('sandbox', $1, $2, '{}')`, ['sbx-' + o.id, o.id])
    : await db.one(`select * from fn_payment_succeeded('sandbox', $1, $2, $3, '{}')`, ['sbx-' + o.id, o.id, body.outcome === 'wrong_amount' ? o.total_pkr - 1 : o.total_pkr]);
  return { order: orderDto(r) };
});

// Provider webhook: body { order_id, provider_ref, amount_pkr, status: "succeeded" | "failed" }, header x-pgbx-signature = HMAC-SHA256(raw body)
route('POST', '/payments/webhook', {}, async ({ db, raw, body, req }) => {
  if (!sec.verifySignature(raw, req.headers['x-pgbx-signature'], payments.webhookSecret)) fail(401, 'BAD_SIGNATURE', 'Invalid signature.');
  const ref = str(body.provider_ref, 120), orderId = str(body.order_id, 40);
  if (!ref || !orderId) fail(400, 'BAD_EVENT', 'Missing fields.');
  // Services (doorstep appraisal fee, gift orders): body.kind = "appraisal" | "gift"
  if (body.kind === 'appraisal' || body.kind === 'gift') {
    if (body.status !== 'succeeded') return { ok: true, status: 'ignored' };
    const r = (await db.one(`select fn_service_paid($1, $2, $3, $4) r`, [body.kind, orderId, ref, int(body.amount_pkr)])).r;
    return { ok: true, status: r.status };
  }
  const r = body.status === 'succeeded'
    ? await db.one(`select * from fn_payment_succeeded($1, $2, $3, $4, $5::jsonb)`, [payments.provider, ref, orderId, int(body.amount_pkr), JSON.stringify({ event: body.event_id || null })])
    : await db.one(`select * from fn_payment_failed($1, $2, $3, $4::jsonb)`, [payments.provider, ref, orderId, JSON.stringify({ event: body.event_id || null })]);
  return { ok: true, status: r.status };
});

route('GET', '/ledger', { auth: 'customer' }, async ({ db, customer, query }) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '2000-01-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '2999-12-31';
  const entries = await db.query(`select l.id, l.product_id, l.delta, l.reason, l.ref, l.unit_price_pkr, l.created_at from ledger l
    where customer_id = $1 and created_at >= $2::date and created_at < $3::date + 1 order by created_at`, [customer.id, from, to]);
  const opening = await db.query(`select product_id, sum(delta)::int units from ledger where customer_id = $1 and created_at < $2::date group by 1 having sum(delta) <> 0`, [customer.id, from]);
  return { from, to, opening, entries };
});

// ---------- collection at a dealer (FR-D1–D9) ----------
route('POST', '/redemptions', { auth: 'customer' }, async ({ db, customer, body }) => {
  const args = [customer.id, str(body.productId, 40), int(body.units), str(body.dealerId, 40)];
  if (!Number.isInteger(args[2])) fail(400, 'BAD_UNITS', MESSAGES.BAD_UNITS[1]);
  for (let i = 0; i < 6; i++) {                                // codes are random; retry on the rare clash with an active code
    try { const r = await db.one(`select * from fn_reserve($1, $2, $3, $4, $5)`, [...args, sec.newCode()]); return { redemption: r }; }
    catch (e) { if (!/redemptions_active_code|23505/.test(e.message + e.code)) throw e; }
  }
  fail(503, 'TRY_AGAIN', 'Please try again.');
});
route('GET', '/redemptions', { auth: 'customer' }, async ({ db, customer }) => {
  const rows = await db.query(`select r.id, r.product_id, r.units, r.dealer_id, d.name as dealer_name, r.code, r.created_at, r.expires_at, r.ready_at, r.completed_at, r.serials,
      case when r.status in ('requested', 'ready') and r.expires_at < now() then 'expired' else r.status end as status
    from redemptions r join dealers d on d.id = r.dealer_id where r.customer_id = $1 order by r.created_at desc limit 100`, [customer.id]);
  return { redemptions: rows.map(r => (['requested', 'ready'].includes(r.status) ? r : { ...r, code: null })) };   // codes only while usable
});
route('POST', '/redemptions/:id/cancel', { auth: 'customer' }, async ({ db, customer, params }) => ({ redemption: await db.one(`select * from fn_cancel_redemption($1, $2)`, [customer.id, params.id]) }));

// ---------- notifications and alerts (FR-N1, FR-R6) ----------
route('GET', '/notifications', { auth: 'customer' }, async ({ db, customer }) =>
  ({ notifications: await db.query(`select id, kind, title, body, link, push, created_at, read_at from notifications where customer_id = $1 order by created_at desc limit 100`, [customer.id]) }));
route('POST', '/notifications/read', { auth: 'customer' }, async ({ db, customer }) => {
  await db.query(`update notifications set read_at = now() where customer_id = $1 and read_at is null`, [customer.id]);
  return { ok: true };
});
route('GET', '/alerts', { auth: 'customer' }, async ({ db, customer }) => ({ alerts: await db.query(`select id, metal, dir, target_pkr, active, fired_at from price_alerts where customer_id = $1 order by created_at desc`, [customer.id]) }));
route('POST', '/alerts', { auth: 'customer' }, async ({ db, customer, body }) => {
  const metal = ['gold', 'silver'].includes(body.metal) ? body.metal : fail(400, 'BAD_METAL', 'Choose gold or silver.');
  const dir = ['above', 'below'].includes(body.dir) ? body.dir : fail(400, 'BAD_DIR', 'Choose above or below.');
  const target = int(body.targetPkr); if (!(target > 0)) fail(400, 'BAD_TARGET', 'Enter a target price.');
  if ((await db.one(`select count(*)::int n from price_alerts where customer_id = $1 and active`, [customer.id])).n >= 20) fail(400, 'TOO_MANY', 'You can have up to 20 active alerts.');
  return { alert: await db.one(`insert into price_alerts (customer_id, metal, dir, target_pkr) values ($1, $2, $3, $4) returning id, metal, dir, target_pkr, active`, [customer.id, metal, dir, target]) };
});
route('DELETE', '/alerts/:id', { auth: 'customer' }, async ({ db, customer, params }) => {
  await db.query(`delete from price_alerts where id = $1 and customer_id = $2`, [params.id, customer.id]);
  return { ok: true };
});

// ---------- support ----------
route('POST', '/support', { auth: 'customer' }, async ({ db, customer, body }) => {
  const topic = str(body.topic, 60) || 'general'; const text = str(body.body, 4000);
  if (text.length < 10) fail(400, 'BAD_REPORT', 'Tell us a little more, at least 10 characters.');
  await limit(db, 'support:' + customer.id, 3600, 5, 'You’ve sent several reports. We’ll reply to those first.');
  const r = await db.one(`insert into support_requests (customer_id, topic, body) values ($1, $2, $3) returning id, created_at`, [customer.id, topic, text]);
  return { request: r };
});

// ---------- services: jewellery worth, doorstep appraisal, gift bullion ----------
// Everything the service screens need, public so guests can use the jewellery worth calculator.
route('GET', '/services/config', {}, async ({ db, fetchRates }) => {
  await ensureRates(db, fetchRates).catch(() => {});
  const set = await settingsMap(db);
  const snap = await db.one(`select * from rate_snapshots where fetched_at > now() - make_interval(secs => setting_int('rate_stale_seconds')) order by id desc limit 1`);
  const items = await db.query(`select id, metal, label, grams::float8 grams, shapes from gift_items where active order by sort`);
  return {
    purity: set.purity, buybackDeductionPct: set.buyback_deduction_pct,
    appraisal: { feePkr: set.appraisal_fee_pkr, cities: set.appraisal_cities, slots: set.appraisal_slots, freeCancelHours: set.appraisal_free_cancel_hours },
    gift: {
      making: set.gift_making_pkr, packaging: set.gift_packaging_pkr, deliveryPkr: set.gift_delivery_pkr, leadDays: set.gift_lead_days, cities: set.gift_cities,
      items: items.map(i => ({ ...i, metalPkr: snap ? Math.round(i.grams * (i.metal === 'gold' ? snap.gold_buy_tola : snap.silver_buy_tola) / TOLA) : null })),
    },
  };
});

const serviceIntent = async (kind, row) => (payments.provider ? payments.createIntent({ id: row.id, kind, total_pkr: row.fee_pkr ?? row.total_pkr }) : null);
const appraisalDto = a => ({ id: a.id, ref: a.ref, city: a.city, area: a.area, address: a.address, phone: a.phone, date: a.visit_date instanceof Date ? a.visit_date.toISOString().slice(0, 10) : String(a.visit_date).slice(0, 10),
  slot: a.slot, items: a.items, notes: a.notes, fee_pkr: a.fee_pkr, visit_code: a.visit_code, status: a.status, goldsmith: a.goldsmith_name ? { name: a.goldsmith_name, phone: a.goldsmith_phone } : null,
  result: a.result, refund_due: a.refund_due, created_at: a.created_at });
const giftDto = g => ({ id: g.id, ref: g.ref, item_id: g.item_id, shape: g.shape, design: g.design, engraving: g.engraving, message: g.message, packaging: g.packaging,
  recipient: { name: g.recipient_name, phone: g.recipient_phone, city: g.recipient_city, address: g.recipient_address },
  deliver_by: g.deliver_by instanceof Date ? g.deliver_by.toISOString().slice(0, 10) : String(g.deliver_by).slice(0, 10),
  metal_pkr: g.metal_pkr, making_pkr: g.making_pkr, packaging_pkr: g.packaging_pkr, delivery_pkr: g.delivery_pkr, total_pkr: g.total_pkr,
  status: g.status, tracking: g.tracking, refund_due: g.refund_due, created_at: g.created_at });
const cleanPhone = v => str(v).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');

route('POST', '/appraisals', { auth: 'customer' }, async ({ db, customer, body }) => {
  if (!payments.provider) fail(503, 'PAYMENTS_OFF', 'Payments aren’t available yet.');
  const items = Array.isArray(body.items) ? body.items.slice(0, 20).map(i => ({
    metal: i.metal === 'silver' ? 'silver' : 'gold', karat: str(i.karat, 8), approx_g: Math.max(0, Math.min(100000, Number(i.approx_g) || 0)), note: str(i.note, 80) })) : [];
  const phone = cleanPhone(body.phone);
  if (!PK_MOBILE.test(phone)) fail(400, 'BAD_PHONE', 'Enter a valid Pakistani mobile number, for example 300 1234567.');
  await limit(db, 'appraisal:' + customer.id, 86400, 5, 'You’ve booked several visits today. Contact PGBX support for more.');
  const a = await db.one(`select * from fn_book_appraisal($1, $2, $3, $4, $5, $6::date, $7, $8::jsonb, $9, $10)`,
    [customer.id, str(body.city, 40), str(body.area, 80), str(body.address, 300), phone, str(body.date, 10), str(body.slot, 20), JSON.stringify(items), str(body.notes, 300), String(sec.newCode()).slice(0, 4)]);
  return { appraisal: appraisalDto(a), payment: await serviceIntent('appraisal', a) };
});
route('GET', '/appraisals', { auth: 'customer' }, async ({ db, customer }) =>
  ({ appraisals: (await db.query(`select * from appraisals where customer_id = $1 and status <> 'pending_payment' or (customer_id = $1 and status = 'pending_payment' and created_at > now() - interval '1 hour') order by created_at desc limit 50`, [customer.id])).map(appraisalDto) }));
route('POST', '/appraisals/:id/cancel', { auth: 'customer' }, async ({ db, customer, params }) => ({ appraisal: appraisalDto(await db.one(`select * from fn_cancel_appraisal($1, $2)`, [customer.id, params.id])) }));

route('POST', '/gifts/quote', {}, async ({ db, body, fetchRates }) => {
  await ensureRates(db, fetchRates);
  return { quote: (await db.one(`select fn_gift_quote($1, $2, $3, $4, $5) q`, [str(body.item, 20), str(body.shape, 10), str(body.design, 20), str(body.engraving, 40), str(body.packaging, 20)])).q };
});
route('POST', '/gifts', { auth: 'customer' }, async ({ db, customer, body, fetchRates }) => {
  if (!payments.provider) fail(503, 'PAYMENTS_OFF', 'Payments aren’t available yet.');
  const phone = cleanPhone(body.recipientPhone);
  if (!PK_MOBILE.test(phone)) fail(400, 'BAD_RECIPIENT', MESSAGES.BAD_RECIPIENT[1]);
  await ensureRates(db, fetchRates);
  const g = await db.one(`select * from fn_place_gift($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date)`,
    [customer.id, str(body.item, 20), str(body.shape, 10), str(body.design, 20), str(body.engraving, 40), str(body.message, 200), str(body.packaging, 20),
      str(body.recipientName, 100), phone, str(body.recipientCity, 40), str(body.recipientAddress, 300), str(body.deliverBy, 10)]);
  return { gift: giftDto(g), payment: await serviceIntent('gift', g) };
});
route('GET', '/gifts', { auth: 'customer' }, async ({ db, customer }) =>
  ({ gifts: (await db.query(`select * from gift_orders where customer_id = $1 and (status <> 'pending_payment' or created_at > now() - interval '1 hour') order by created_at desc limit 50`, [customer.id])).map(giftDto) }));
route('POST', '/gifts/:id/cancel', { auth: 'customer' }, async ({ db, customer, params }) => ({ gift: giftDto(await db.one(`select * from fn_cancel_gift($1, $2)`, [customer.id, params.id])) }));

// Sandbox only: pays a booking or gift order the way a provider webhook would
route('POST', '/payments/sandbox/:kind/:id', { auth: 'customer' }, async ({ db, customer, params }) => {
  if (!payments.sandbox) fail(404, 'NOT_FOUND', 'Not found.');
  const table = { appraisal: 'appraisals', gift: 'gift_orders' }[params.kind];
  if (!table) fail(404, 'NOT_FOUND', 'Not found.');
  const row = await db.one(`select * from ${table} where id = $1 and customer_id = $2`, [params.id, customer.id]);
  if (!row) fail(404, 'NOT_FOUND', 'Not found.');
  const r = (await db.one(`select fn_service_paid($1, $2, $3, $4) r`, [params.kind, row.id, 'sbx-' + row.id, row.fee_pkr ?? row.total_pkr])).r;
  return { status: r.status };
});

// ---------- closing the account ----------
route('POST', '/account/close', { auth: 'customer' }, async ({ db, customer, res }) => {
  const r = (await db.one(`select fn_close_account($1) as r`, [customer.id])).r;
  if (r.closed) setCookie(res, 'pgbx_s', '', 0);
  return r;
});

// ---------- staff sign-in (password + authenticator code) ----------
route('POST', '/staff/login', {}, async ({ db, body, req, res }) => {
  const email = str(body.email, 200).toLowerCase();
  await limit(db, 'staff-login-ip:' + clientIp(req), 900, 20, 'Too many sign-in attempts. Try again in 15 minutes.');
  await limit(db, 'staff-login:' + email, 900, 8, 'Too many sign-in attempts. Try again in 15 minutes.');
  const s = await db.one(`select * from staff where email = $1 and active`, [email]);
  const ok = s ? sec.verifyPassword(str(body.password, 200), s.password_hash) : (sec.verifyPassword('x', sec.hashPassword('y')), false);  // same work either way
  if (!ok) { await audit(db, 'system', 'staff.login_failed', 'staff', email, { ip: clientIp(req) }); fail(401, 'BAD_LOGIN', 'Email or password is incorrect.'); }
  const token = sec.newToken();
  await db.query(`insert into staff_sessions (token_hash, staff_id, expires_at) values ($1, $2, now() + interval '12 hours')`, [sec.hashToken(token), s.id]);
  setCookie(res, 'pgbx_staff', token, 12 * 3600);
  return { token, mfaRequired: true };
});
route('POST', '/staff/mfa', { staff: { preMfa: true } }, async ({ db, staff, body, req }) => {
  await limit(db, 'staff-mfa:' + staff.id, 900, 6, 'Too many wrong codes. Sign in again in 15 minutes.');
  if (!sec.verifyTotp(staff.totp_secret, body.code)) { await audit(db, 'staff:' + staff.id, 'staff.mfa_failed', 'staff', staff.id, { ip: clientIp(req) }); fail(401, 'BAD_CODE', 'That code is incorrect. Use the current code from your authenticator app.'); }
  await db.query(`update staff_sessions set mfa_passed = true where token_hash = $1`, [staff.token_hash]);
  await audit(db, 'staff:' + staff.id, 'staff.login', 'staff', staff.id, { ip: clientIp(req) });
  return { ok: true, staff: { name: staff.name, role: staff.role, dealer_id: staff.dealer_id } };
});
route('POST', '/staff/logout', { staff: { preMfa: true } }, async ({ db, staff, res }) => {
  await db.query(`update staff_sessions set revoked_at = now() where token_hash = $1`, [staff.token_hash]);
  setCookie(res, 'pgbx_staff', '', 0);
  return { ok: true };
});
route('GET', '/staff/me', { staff: {} }, async ({ db, staff }) => {
  const dealer = staff.dealer_id ? await db.one(`select id, name, area from dealers where id = $1`, [staff.dealer_id]) : null;
  return { staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, dealer } };
});

// ---------- dealer tools (FR-DL1–DL4) ----------
const dealerOnly = { staff: { roles: ['dealer'] } };
route('POST', '/dealer/lookup', dealerOnly, async ({ db, staff, body }) => {
  await limit(db, 'dealer-lookup:' + staff.id, 600, 30, 'Too many lookups. Wait a few minutes.');
  const code = str(body.code).replace(/\D/g, '');
  if (code.length !== 6) fail(400, 'BAD_CODE', 'Enter the customer’s 6-digit code.');
  return { redemption: (await db.one(`select fn_dealer_lookup($1, $2) as r`, [staff.id, code])).r };
});
route('GET', '/dealer/redemptions', dealerOnly, async ({ db, staff }) => ({
  redemptions: await db.query(`select r.id, r.product_id, r.units, r.status, r.created_at, r.expires_at, r.ready_at, r.completed_at, r.serials, c.name as customer_name
    from redemptions r join customers c on c.id = r.customer_id
    where r.dealer_id = $1 and (r.status in ('requested', 'ready') and r.expires_at > now() or r.completed_at > now() - interval '1 day') order by r.created_at`, [staff.dealer_id]),
}));
route('POST', '/dealer/redemptions/:id/ready', dealerOnly, async ({ db, staff, params }) => ({ redemption: await db.one(`select id, status from fn_dealer_ready($1, $2)`, [staff.id, params.id]) }));
route('POST', '/dealer/redemptions/:id/handover', dealerOnly, async ({ db, staff, params, body }) => {
  const serials = Array.isArray(body.serials) ? body.serials.map(s => str(s, 60).toUpperCase()) : [];
  return { redemption: await db.one(`select id, status, serials from fn_dealer_handover($1, $2, $3, $4)`, [staff.id, params.id, serials, body.cnicChecked === true]) };
});
route('GET', '/dealer/stock', dealerOnly, async ({ db, staff }) =>
  ({ stock: await db.query(`select s.product_id, p.label, p.metal, s.units, s.updated_at from dealer_stock s join products p on p.id = s.product_id where s.dealer_id = $1 order by p.sort`, [staff.dealer_id]) }));

// ---------- admin panel (FR-M1–M10) ----------
const ops = { staff: { roles: ['admin', 'ops'] } };
const adminOnly = { staff: { roles: ['admin'] } };
route('GET', '/admin/overview', ops, async ({ db }) => ({
  customers: (await db.one(`select count(*)::int n from customers where status = 'active'`)).n,
  verified: (await db.one(`select count(*)::int n from customers where kyc_status = 'verified' and status = 'active'`)).n,
  kyc_review: (await db.one(`select count(*)::int n from kyc_checks where status in ('review', 'submitted')`)).n,
  flagged_orders: (await db.one(`select count(*)::int n from orders where status = 'flagged'`)).n,
  sales_today_pkr: (await db.one(`select coalesce(sum(total_pkr), 0) v from orders where status = 'credited' and credited_at >= date_trunc('day', now())`)).v,
  orders_today: (await db.one(`select count(*)::int n from orders where status = 'credited' and credited_at >= date_trunc('day', now())`)).n,
  active_collections: (await db.one(`select count(*)::int n from redemptions where status in ('requested', 'ready') and expires_at > now()`)).n,
  appraisals_to_assign: (await db.one(`select count(*)::int n from appraisals where status = 'booked'`)).n,
  gifts_open: (await db.one(`select count(*)::int n from gift_orders where status in ('placed', 'in_production', 'dispatched')`)).n,
  support_open: (await db.one(`select count(*)::int n from support_requests where status = 'open'`)).n,
  rates: await db.one(`select gold_buy_tola, gold_sell_tola, silver_buy_tola, silver_sell_tola, source, fetched_at from rate_snapshots order by id desc limit 1`),
}));

route('GET', '/admin/settings', ops, async ({ db }) => ({ settings: await db.query(`select key, value, updated_at, updated_by from settings order by key`) }));
route('PATCH', '/admin/settings', adminOnly, async ({ db, staff, body }) => {
  const known = new Set((await db.query(`select key from settings`)).map(r => r.key));
  for (const [k, v] of Object.entries(body || {})) {
    if (!known.has(k)) fail(400, 'BAD_SETTING', `Unknown setting ${k}.`);
    await db.query(`update settings set value = $2::jsonb, updated_at = now(), updated_by = $3 where key = $1`, [k, JSON.stringify(v), 'staff:' + staff.id]);
    await audit(db, 'staff:' + staff.id, 'setting.changed', 'setting', k, { value: v });
  }
  return { ok: true };
});

route('GET', '/admin/products', ops, async ({ db }) => ({ products: await db.query(`select id, metal, label, grams::float8 grams, premium_pkr, active from products order by sort`) }));
route('PATCH', '/admin/products/:id', adminOnly, async ({ db, staff, params, body }) => {
  const premium = 'premium_pkr' in body ? int(body.premium_pkr) : null;
  if (premium !== null && !(premium >= 0)) fail(400, 'BAD_PREMIUM', 'Enter a premium of 0 or more.');
  const p = await db.one(`update products set premium_pkr = coalesce($2, premium_pkr), active = coalesce($3, active) where id = $1 returning id, premium_pkr, active`,
    [params.id, premium, typeof body.active === 'boolean' ? body.active : null]);
  if (!p) fail(404, 'NOT_FOUND', 'Product not found.');
  await audit(db, 'staff:' + staff.id, 'product.changed', 'product', params.id, body);
  return { product: p };
});

route('GET', '/admin/dealers', ops, async ({ db }) => ({
  dealers: await db.query(`select d.*, d.lat::float8 lat, d.lng::float8 lng, coalesce((select json_object_agg(product_id, units) from dealer_stock s where s.dealer_id = d.id), '{}') as stock from dealers d order by name`),
}));
route('POST', '/admin/dealers', adminOnly, async ({ db, staff, body }) => {
  const id = str(body.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, ''); const name = str(body.name, 120); const area = str(body.area, 120);
  if (!id || !name || !area) fail(400, 'BAD_DEALER', 'Enter an ID, name and area.');
  const d = await db.one(`insert into dealers (id, name, area, address, phone, lat, lng, hours) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [id, name, area, str(body.address, 300) || null, str(body.phone, 40) || null, Number(body.lat) || null, Number(body.lng) || null, str(body.hours, 60) || null]);
  await db.query(`insert into dealer_stock (dealer_id, product_id, units) select $1, id, 0 from products`, [id]);
  await audit(db, 'staff:' + staff.id, 'dealer.created', 'dealer', id, { name });
  return { dealer: d };
});
route('PATCH', '/admin/dealers/:id', adminOnly, async ({ db, staff, params, body }) => {
  const d = await db.one(`update dealers set name = coalesce($2, name), area = coalesce($3, area), address = coalesce($4, address), phone = coalesce($5, phone),
      hours = coalesce($6, hours), active = coalesce($7, active) where id = $1 returning id, active`,
    [params.id, str(body.name, 120) || null, str(body.area, 120) || null, str(body.address, 300) || null, str(body.phone, 40) || null, str(body.hours, 60) || null, typeof body.active === 'boolean' ? body.active : null]);
  if (!d) fail(404, 'NOT_FOUND', 'Dealer not found.');
  await audit(db, 'staff:' + staff.id, 'dealer.changed', 'dealer', params.id, body);
  return { dealer: d };
});
route('PUT', '/admin/dealers/:id/stock', ops, async ({ db, staff, params, body }) => {
  const units = int(body.units); if (!(units >= 0)) fail(400, 'BAD_UNITS', 'Enter 0 or more units.');
  const r = await db.one(`update dealer_stock set units = $3, updated_at = now() where dealer_id = $1 and product_id = $2 returning units`, [params.id, str(body.product_id, 40), units]);
  if (!r) fail(404, 'NOT_FOUND', 'Dealer or product not found.');
  await audit(db, 'staff:' + staff.id, 'stock.set', 'dealer', params.id, { product_id: body.product_id, units, note: str(body.note, 200) });
  return { ok: true };
});

route('GET', '/admin/customers', ops, async ({ db, query }) => {
  const q = str(query.q || '', 60);
  const rows = await db.query(`select id, phone, name, cnic, kyc_status, status, created_at from customers
    where $1 = '' or phone like '%' || $1 || '%' or lower(name) like '%' || lower($1) || '%' or replace(cnic, '-', '') like '%' || replace($1, '-', '') || '%'
    order by created_at desc limit 50`, [q]);
  return { customers: rows };
});
route('GET', '/admin/customers/:id', ops, async ({ db, params, staff }) => {
  const c = await db.one(`select id, phone, closed_phone, name, cnic, dob, email, address, kyc_status, kyc_at, status, created_at, closed_at from customers where id = $1`, [params.id]);
  if (!c) fail(404, 'NOT_FOUND', 'Customer not found.');
  await audit(db, 'staff:' + staff.id, 'customer.viewed', 'customer', params.id, {});   // who looked at personal data
  return {
    customer: c, wallet: await walletOf(db, c.id),
    orders: await db.query(`select id, receipt_no, status, total_pkr, created_at from orders where customer_id = $1 order by created_at desc limit 50`, [c.id]),
    redemptions: await db.query(`select id, product_id, units, dealer_id, status, created_at from redemptions where customer_id = $1 order by created_at desc limit 50`, [c.id]),
    kyc: await db.query(`select id, provider, status, reason, created_at, decided_at, decided_by from kyc_checks where customer_id = $1 order by created_at desc`, [c.id]),
  };
});
route('POST', '/admin/customers/:id/status', adminOnly, async ({ db, staff, params, body }) => {
  const status = ['active', 'suspended'].includes(body.status) ? body.status : fail(400, 'BAD_STATUS', 'Choose active or suspended.');
  const c = await db.one(`update customers set status = $2 where id = $1 and status <> 'closed' returning id, status`, [params.id, status]);
  if (!c) fail(404, 'NOT_FOUND', 'Customer not found or closed.');
  if (status === 'suspended') await db.query(`update sessions set revoked_at = now() where customer_id = $1 and revoked_at is null`, [params.id]);
  await audit(db, 'staff:' + staff.id, 'customer.' + status, 'customer', params.id, { reason: str(body.reason, 300) });
  return { customer: c };
});

route('GET', '/admin/kyc', ops, async ({ db, query }) => {
  const status = ['review', 'submitted', 'failed', 'passed'].includes(query.status) ? query.status : 'review';
  return { checks: await db.query(`select k.id, k.customer_id, c.name, c.cnic, c.phone, k.provider, k.status, k.reason, k.created_at from kyc_checks k join customers c on c.id = k.customer_id where k.status = $1 order by k.created_at`, [status]) };
});
route('POST', '/admin/kyc/:id/decide', ops, async ({ db, staff, params, body }) => {
  const decision = ['passed', 'failed'].includes(body.decision) ? body.decision : fail(400, 'BAD_DECISION', 'Choose pass or fail.');
  const k = await db.one(`update kyc_checks set status = $2, reason = $3, decided_at = now(), decided_by = $4 where id = $1 and status in ('review', 'submitted') returning customer_id`,
    [params.id, decision, str(body.reason, 300) || null, 'staff:' + staff.id]);
  if (!k) fail(404, 'NOT_FOUND', 'This check is no longer waiting for review.');
  await db.query(`update customers set kyc_status = $2, kyc_at = case when $2 = 'verified' then now() else kyc_at end where id = $1`, [k.customer_id, decision === 'passed' ? 'verified' : 'failed']);
  await db.query(`select notify_customer($1, 'account', $2, $3, null, true)`, [k.customer_id, decision === 'passed' ? 'Identity verified' : 'We couldn’t verify your identity',
    decision === 'passed' ? 'You can now buy gold and silver.' : 'Check your CNIC details and try again, or contact PGBX support.']);
  await audit(db, 'staff:' + staff.id, 'kyc.decided', 'kyc', params.id, { decision, reason: body.reason || null });
  return { ok: true };
});

route('GET', '/admin/orders', ops, async ({ db, query }) => {
  const status = ['flagged', 'pending_payment', 'credited', 'refunded', 'failed', 'expired'].includes(query.status) ? query.status : 'flagged';
  return { orders: await db.query(`select o.id, o.receipt_no, o.status, o.total_pkr, o.note, o.created_at, o.paid_at, c.name, c.phone from orders o join customers c on c.id = o.customer_id where o.status = $1 order by o.created_at desc limit 200`, [status]) };
});
route('POST', '/admin/orders/:id/resolve', ops, async ({ db, staff, params, body }) =>
  ({ order: orderDto(await db.one(`select * from fn_resolve_order($1, $2, $3, $4)`, [staff.id, params.id, str(body.action, 10), str(body.note, 300) || null])) }));

route('GET', '/admin/reconciliation', ops, async ({ db, query }) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.day || '') ? query.day : new Date().toISOString().slice(0, 10);
  return { reconciliation: (await db.one(`select fn_reconcile($1::date) as r`, [day])).r };
});
route('POST', '/admin/vault', ops, async ({ db, staff, body }) => {
  const units = int(body.units); if (!(units >= 0)) fail(400, 'BAD_UNITS', 'Enter 0 or more units.');
  await db.query(`insert into vault_counts (product_id, units, counted_by, note) values ($1, $2, $3, $4)`, [str(body.product_id, 40), units, 'staff:' + staff.id, str(body.note, 200) || null]);
  await audit(db, 'staff:' + staff.id, 'vault.counted', 'product', body.product_id, { units });
  return { ok: true };
});

route('GET', '/admin/support', ops, async ({ db, query }) => {
  const status = query.status === 'closed' ? 'closed' : 'open';
  return { requests: await db.query(`select s.id, s.topic, s.body, s.status, s.created_at, s.closed_at, s.closed_by, c.id as customer_id, c.name, c.phone
    from support_requests s left join customers c on c.id = s.customer_id where s.status = $1 order by s.created_at desc limit 200`, [status]) };
});
route('POST', '/admin/support/:id/close', ops, async ({ db, staff, params, body }) => {
  const r = await db.one(`update support_requests set status = 'closed', closed_at = now(), closed_by = $2 where id = $1 and status = 'open' returning customer_id`, [params.id, 'staff:' + staff.id]);
  if (!r) fail(404, 'NOT_FOUND', 'This request is already closed.');
  const reply = str(body.reply, 1000);
  if (reply && r.customer_id) await db.query(`select notify_customer($1, 'account', 'Reply from PGBX support', $2, null, true)`, [r.customer_id, reply]);
  await audit(db, 'staff:' + staff.id, 'support.closed', 'support', params.id, { replied: !!reply });
  return { ok: true };
});

// Services queues for operations
route('GET', '/admin/appraisals', ops, async ({ db, query }) => {
  const status = ['booked', 'confirmed', 'completed', 'cancelled'].includes(query.status) ? query.status : 'booked';
  return { appraisals: (await db.query(`select a.*, c.name as customer_name from appraisals a join customers c on c.id = a.customer_id where a.status = $1 order by a.visit_date, a.slot limit 200`, [status]))
    .map(a => ({ ...appraisalDto(a), customer_name: a.customer_name })) };
});
route('POST', '/admin/appraisals/:id', ops, async ({ db, staff, params, body }) => {
  const action = ['assign', 'complete', 'cancel'].includes(body.action) ? body.action : fail(400, 'BAD_ACTION', MESSAGES.BAD_ACTION[1]);
  const data = action === 'assign' ? { name: str(body.name, 80), phone: str(body.phone, 20) }
    : action === 'complete' ? { summary: str(body.summary, 1000), net_g: Number(body.net_g) || null, karat: str(body.karat, 8) || null, value_pkr: int(body.value_pkr) || null }
    : { reason: str(body.reason, 300) || null };
  if (action === 'complete' && data.summary.length < 5) fail(400, 'BAD_RESULT', 'Write the assay result for the customer.');
  return { appraisal: appraisalDto(await db.one(`select * from fn_appraisal_update($1, $2, $3, $4::jsonb)`, [staff.id, params.id, action, JSON.stringify(data)])) };
});
route('GET', '/admin/gifts', ops, async ({ db, query }) => {
  const status = ['placed', 'in_production', 'dispatched', 'delivered', 'cancelled'].includes(query.status) ? query.status : 'placed';
  return { gifts: (await db.query(`select g.*, c.name as customer_name, i.label as item_label, i.metal from gift_orders g join customers c on c.id = g.customer_id join gift_items i on i.id = g.item_id
    where g.status = $1 order by g.deliver_by limit 200`, [status])).map(g => ({ ...giftDto(g), customer_name: g.customer_name, item_label: g.item_label, metal: g.metal })) };
});
route('POST', '/admin/gifts/:id', ops, async ({ db, staff, params, body }) => {
  const action = ['produce', 'dispatch', 'deliver', 'cancel'].includes(body.action) ? body.action : fail(400, 'BAD_ACTION', MESSAGES.BAD_ACTION[1]);
  const data = { tracking: str(body.tracking, 60) || undefined, reason: str(body.reason, 300) || undefined };
  return { gift: giftDto(await db.one(`select * from fn_gift_update($1, $2, $3, $4::jsonb)`, [staff.id, params.id, action, JSON.stringify(data)])) };
});

route('GET', '/admin/audit', ops, async ({ db, query }) => {
  const entity = str(query.entity || '', 40), id = str(query.id || '', 80);
  return { entries: await db.query(`select id, at, actor, action, entity, entity_id, data from audit_log where ($1 = '' or entity = $1) and ($2 = '' or entity_id = $2) order by id desc limit 200`, [entity, id]) };
});

route('GET', '/admin/staff', adminOnly, async ({ db }) => ({ staff: await db.query(`select id, email, name, role, dealer_id, active, created_at from staff order by created_at`) }));
route('POST', '/admin/staff', adminOnly, async ({ db, staff, body }) => {
  const email = str(body.email, 200).toLowerCase(); const name = str(body.name, 120);
  const role = ['admin', 'ops', 'dealer'].includes(body.role) ? body.role : fail(400, 'BAD_ROLE', 'Choose a role.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) fail(400, 'BAD_STAFF', 'Enter a name and a valid email.');
  if (role === 'dealer' && !body.dealer_id) fail(400, 'BAD_STAFF', 'Choose the dealer this person works for.');
  const password = sec.newPassword(), secret = sec.newTotpSecret();
  const s = await db.one(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret) values ($1, $2, $3, $4, $5, $6) returning id`,
    [email, name, role, role === 'dealer' ? str(body.dealer_id, 40) : null, sec.hashPassword(password), secret]);
  await audit(db, 'staff:' + staff.id, 'staff.created', 'staff', s.id, { email, role });
  return { staff: { id: s.id, email, role }, setup: { password, totpSecret: secret, otpauthUrl: sec.otpauthUrl(secret, email), note: 'Shown once. Share securely and ask them to change the password.' } };
});
route('POST', '/admin/staff/:id/active', adminOnly, async ({ db, staff, params, body }) => {
  if (params.id === staff.id) fail(400, 'SELF', 'You can’t deactivate your own account.');
  await db.query(`update staff set active = $2 where id = $1`, [params.id, body.active === true]);
  if (body.active !== true) await db.query(`update staff_sessions set revoked_at = now() where staff_id = $1 and revoked_at is null`, [params.id]);
  await audit(db, 'staff:' + staff.id, body.active === true ? 'staff.activated' : 'staff.deactivated', 'staff', params.id, {});
  return { ok: true };
});

// ---------- scheduled jobs ----------
route('GET', '/cron/sweep', {}, async ({ db, req, fetchRates }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) fail(401, 'UNAUTHORIZED', 'Unauthorized.');
  const r = {
    expired_orders: (await db.one(`select fn_expire_orders() n`)).n,
    expired_redemptions: (await db.one(`select fn_expire_redemptions() n`)).n,
    expired_services: (await db.one(`select fn_expire_services() n`)).n,
    purged_customers: (await db.one(`select fn_purge_closed() n`)).n,
  };
  await ensureRates(db, fetchRates).catch(() => {});
  r.pushed = await sendPendingPush(db);
  return r;
});
async function sendPendingPush(db) {
  const pending = await db.query(`select n.id, n.customer_id, n.title, n.body, n.link from notifications n where n.push and n.pushed_at is null and n.created_at > now() - interval '1 day' limit 500`);
  let sent = 0;
  for (const n of pending) {
    if (push.enabled) {
      for (const t of await db.query(`select token from push_tokens where customer_id = $1`, [n.customer_id])) {
        const r = await push.send(t.token, n).catch(() => ({ ok: false }));
        if (r.gone) await db.query(`delete from push_tokens where token = $1`, [t.token]);
        if (r.ok) sent++;
      }
    }
    await db.query(`update notifications set pushed_at = now() where id = $1`, [n.id]);
  }
  return sent;
}

// ---------- entry point ----------
export async function handle(req, res, opts = {}) {
  const db = opts.db || (await getDb());
  const fetchRates = opts.fetchRates || fetchLiveRates;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }
  const send = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  const url = new URL(req.url, 'http://x');
  const path = (url.searchParams.get('path') ? '/' + url.searchParams.get('path') : url.pathname.replace(/^\/api\/v1/, '')) || '/';
  const query = Object.fromEntries(url.searchParams);
  try {
    let match = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(path);
      if (m) { match = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }
    if (!match) fail(404, 'NOT_FOUND', 'Not found.');
    if (!db && path !== '/config') fail(503, 'NOT_CONNECTED', 'PGBX services aren’t connected yet.');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    if (hasBody && !String(req.headers['content-type'] || '').includes('application/json'))
      fail(415, 'JSON_ONLY', 'Send JSON.');
    const { raw, json } = await readBody(req);
    const ctx = { req, res, db, raw, body: json && typeof json === 'object' ? json : {}, params, query, fetchRates };
    if (match.opts.auth === 'customer') ctx.customer = await customerFrom(ctx);
    if (match.opts.staff) ctx.staff = await staffFrom(ctx, match.opts.staff);
    send(200, await match.handler(ctx));
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
    const code = String(e.message || '').match(/^[A-Z_]+$/) ? e.message : null;
    if (code && MESSAGES[code]) return send(MESSAGES[code][0], { error: code, message: MESSAGES[code][1] });
    if (e.expose) return send(e.status || 400, { error: 'PROVIDER', message: e.message });
    if (e.code === '22P02') return send(400, { error: 'BAD_ID', message: 'That ID isn’t valid.' });
    console.error('PGBX API error', req.method, path, e);
    send(500, { error: 'SERVER', message: 'Something went wrong on our side. Please try again.' });
  }
}
