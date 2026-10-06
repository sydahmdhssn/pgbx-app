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
  // $1 gold
  BAD_GRAMS: [400, 'Enter how many grams to sell (at least 0.001 g).'],
  INSUFFICIENT_GOLD: [409, 'You don’t have that much gold. Check your balance and try again.'],
  BAD_IBAN: [400, 'Enter your bank IBAN: 24 characters starting with PK, for example PK36SCBL0000001123456702.'],
  LOT_NOT_FULL: [409, 'This lot isn’t a full tola yet.'],
  BAR_SERIAL_USED: [409, 'That bar serial is already recorded for another lot. Check the serial on the bar.'],
  DUPLICATE_LINE: [400, 'Each product can appear only once in an order.'],
  BAD_AMOUNT: [400, 'The payment amount is missing or not valid.'],
  BAD_EVENT: [400, 'The payment event is missing its reference.'],
  BAD_KEY: [400, 'Missing request key.'],
  BAD_REF: [400, 'Enter the bank transfer reference.'],
};

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };

// ---------- routing ----------
const routes = [];
const DUMMY_HASH = sec.hashPassword('not-a-real-password');   // for unknown emails, so sign-in takes the same time
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}

// ---------- helpers ----------
const clientIp = req => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
const decode = v => { try { return decodeURIComponent(v); } catch { return null; } };
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decode(v.join('=')) || '']));
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
    const parts = []; let size = 0;                            // bytes, so multi-byte characters split across chunks stay intact
    for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 65536) fail(413, 'TOO_LARGE', 'Request too large.'); parts.push(b); }
    raw = Buffer.concat(parts).toString('utf8');
  }
  if (!raw && req.body) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  if (!raw) return { raw: '', json: {} };
  try { return { raw, json: JSON.parse(raw) }; } catch { fail(400, 'BAD_JSON', 'The request couldn’t be read.'); }
}
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = v => (Number.isSafeInteger(v) ? v : typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim()) ? Number(v) : NaN);   // '' and null are not 0
async function limit(db, key, windowSec, max, message) {
  const r = await db.one(`select fn_rate_limit($1, $2, $3) as wait`, [key, windowSec, max]);
  if (r.wait > 0) fail(429, 'RATE_LIMITED', message || 'Too many attempts. Please wait and try again.', { retryIn: r.wait });
}
const audit = (db, actor, action, entity, id, data = {}) => db.query(`select audit($1, $2, $3, $4, $5::jsonb)`, [actor, action, entity, id, JSON.stringify(data)]);
const settingsMap = async db => Object.fromEntries((await db.query(`select key, value from settings`)).map(r => [r.key, r.value]));

// FR-R4: prices whose source timestamp is older than this are not recorded, so nothing can be locked at them.
const SOURCE_STALE_MS = 90000;
// A price without a source time is treated as stale (fail closed).
const sourceFresh = d => ['gold', 'silver'].every(k => { const t = Date.parse(d.metals[k] && d.metals[k].sourceUpdatedAt); return Number.isFinite(t) && Date.now() - t <= SOURCE_STALE_MS; });

// A jump of more than 10% from the last recorded price within an hour is almost always a bad feed, not the market:
// such prices are not recorded (so nothing can be locked at them) until operations checks the sources.
const MAX_JUMP = 0.10;
const plausible = (d, last) => !last || last.age > 3600 || [['gold', last.gold_buy_tola], ['silver', last.silver_buy_tola]]
  .every(([k, prev]) => Math.abs(d.metals[k].buyTola / Number(prev) - 1) <= MAX_JUMP);
const validRates = d => d && d.ok && ['gold', 'silver'].every(k => d.metals?.[k] && d.metals[k].buyTola > 0 && d.metals[k].sellTola > 0 && d.metals[k].sellTola <= d.metals[k].buyTola);
// Each snapshot also keeps the USD/PKR rate, which prices $1 gold. A missing or implausible dollar rate is left out,
// so $1 purchases pause (RATES_STALE) instead of using a wrong rate.
async function recordRates(db, d) {
  let usd = Number(d.usdPkr && d.usdPkr.rate);
  if (!(usd > 100 && usd < 1000)) usd = null;
  if (usd) {
    const prev = await db.one(`select usd_pkr from rate_snapshots where usd_pkr is not null and fetched_at > now() - interval '1 day' order by id desc limit 1`);
    if (prev && Math.abs(usd / Number(prev.usd_pkr) - 1) > MAX_JUMP) usd = null;
  }
  return db.one(`select fn_record_rates($1, $2, $3, $4, $5, $6) as id`, [d.metals.gold.buyTola, d.metals.gold.sellTola, d.metals.silver.buyTola, d.metals.silver.sellTola, d.metals.gold.source || 'live', usd]);
}

// The live sources are called at most every 5 s per server instance, however many requests arrive.
const rateCache = new Map();
function cachedRates(fetchRates, opts) {
  if (fetchRates !== fetchLiveRates) return fetchRates(opts);   // tests and the dev server pass their own source
  const key = JSON.stringify(opts), hit = rateCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.p;
  const p = fetchRates(opts); rateCache.set(key, { at: Date.now(), p });
  p.catch(() => rateCache.delete(key));
  if (rateCache.size > 50) rateCache.delete(rateCache.keys().next().value);
  return p;
}

// Keep a recent rate snapshot: every price lock uses the server's own snapshot (Rule 1).
async function ensureRates(db, fetchRates) {
  const s = await db.one(`select *, extract(epoch from now() - fetched_at) as age from rate_snapshots order by id desc limit 1`);
  const stale = Number((await db.one(`select setting_int('rate_stale_seconds') as v`)).v);
  if (s && s.age < stale / 2) return s;
  const set = await settingsMap(db);
  const d = await cachedRates(fetchRates, { spread: set.spread || undefined }).catch(() => null);
  if (!validRates(d) || !sourceFresh(d) || !plausible(d, s)) return s;   // the lock function refuses stale prices
  await recordRates(db, d);
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
async function staffFrom(ctx, { preMfa = false, roles, beforePasswordChange = false } = {}) {
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
  if (!preMfa && !beforePasswordChange && s.must_change_password) fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.');
  if (roles && !roles.includes(s.role)) fail(403, 'FORBIDDEN', 'Your role can’t do this.');
  if (roles && s.role === 'dealer' && !(await db.one(`select 1 from dealers where id = $1 and active`, [s.dealer_id])))
    fail(403, 'DEALER_INACTIVE', 'This dealer counter is not active. Contact PGBX operations.');
  return s;
}
// Cookie-authenticated changes must come from the app's own pages (with SameSite=Strict this blocks cross-site requests).
function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin) return;                                        // non-browser clients send no Origin
  let same = false; try { same = new URL(origin).host === host; } catch { }   // "null" and other non-URLs are never same-origin
  if (ALLOWED_ORIGIN.test(origin) || same) return;
  fail(403, 'BAD_ORIGIN', 'Request blocked.');
}

// ---------- public ----------
const PUBLIC_SETTINGS = ['max_units_per_order', 'daily_limit_pkr', 'min_purchase_pkr', 'price_lock_seconds', 'rate_stale_seconds', 'redemption_valid_hours', 'redemption_fee_pkr', 'order_payment_minutes', 'micro_usd', 'micro_max_units', 'micro_min_sell_g'];
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
  const d = await cachedRates(fetchRates, { spread: set.spread || undefined, premiums }).catch(() => null);
  if (!validRates(d)) fail(502, 'RATES_DOWN', 'Live rates are unavailable right now.');
  if (!sourceFresh(d)) fail(502, 'RATES_STALE_SOURCE', 'Live rates are delayed right now. Buying is paused until they update.');
  const last = await db.one(`select *, extract(epoch from now() - fetched_at) as age from rate_snapshots order by id desc limit 1`);
  if (!plausible(d, last)) {
    console.error('PGBX rates: implausible jump, not recorded', d.metals.gold.buyTola, last && last.gold_buy_tola);
    fail(502, 'RATES_CHECK', 'Live rates are being checked. Buying is paused until they’re confirmed.');
  }
  if (!last || last.age >= 5) await recordRates(db, d);
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
  // Wrong codes per number are counted only when they are wrong, so nobody can lock a number out by guessing first
  if ((await db.one(`select rate_hits($1, 3600) n`, ['otp-fail-h:' + phone])).n >= 10) fail(429, 'RATE_LIMITED', 'Too many wrong codes. Request a new code later.');
  if (!(await otp.check(phone, code))) { await limit(db, 'otp-fail-h:' + phone, 3600, 1000); fail(400, 'WRONG_CODE', 'That code is incorrect. Check the message and try again.'); }
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
  // Web: the session lives only in the HttpOnly cookie, so page scripts never see it. Native apps ask for the token
  // (cookie: false) and keep it in the phone's secure storage.
  if (body.cookie === false) return { token, customer: { id: c.id, isNew } };
  setCookie(res, 'pgbx_s', token, days * 86400);
  return { customer: { id: c.id, isNew } };
});

route('POST', '/auth/logout', { auth: 'customer' }, async ({ db, customer, res, body }) => {
  await db.query(`update sessions set revoked_at = now() where token_hash = $1`, [customer.token_hash]);
  const pushToken = str(body.pushToken, 400);                // this phone stops getting the account's notifications
  if (pushToken) await db.query(`delete from push_tokens where token = $1 and customer_id = $2`, [pushToken, customer.id]);
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
  const g = Number((await db.one(`select micro_grams($1) g`, [customerId])).g);
  const gold_savings = { grams: g, value_pkr: snap ? Math.floor(g * Math.round(snap.gold_sell_tola / TOLA * 100) / 100) : 0 };     // as a sale would pay
  return { holdings, gold_savings, total_value_pkr: holdings.reduce((a, h) => a + h.value_pkr, 0) + gold_savings.value_pkr, priced_at: snap?.fetched_at || null };
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

// Strict YYYY-MM-DD that is a real calendar date
const isoDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m) return null; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.toISOString().slice(0, 10) === v ? d : null; };
const ageOn = (d, now = new Date()) => (now - d) / (365.2425 * 864e5);
const cnicFmt = c => `${c.slice(0, 5)}-${c.slice(5, 12)}-${c.slice(12)}`;

route('PATCH', '/me', { auth: 'customer' }, async ({ db, customer, body }) => {
  const f = {};
  if ('name' in body) { f.name = str(body.name, 100); if (f.name.length < 3) fail(400, 'BAD_NAME', 'Enter your full name.'); }
  if ('cnic' in body) { f.cnic = str(body.cnic).replace(/\D/g, ''); if (f.cnic.length !== 13) fail(400, 'BAD_CNIC', 'Enter all 13 digits of your CNIC.'); f.cnic = `${f.cnic.slice(0, 5)}-${f.cnic.slice(5, 12)}-${f.cnic.slice(12)}`; }
  if ('dob' in body) { f.dob = str(body.dob, 10); const d = isoDate(f.dob); if (!d) fail(400, 'BAD_DOB', 'Enter your date of birth as on your CNIC.'); const age = ageOn(d); if (!(age >= 18 && age < 120)) fail(400, 'BAD_DOB', 'You must be 18 or older.'); }
  if ('email' in body) { f.email = str(body.email, 200) || null; if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) fail(400, 'BAD_EMAIL', 'Enter a valid email address, for example name@example.com.'); }
  if ('address' in body) f.address = str(body.address, 300) || null;
  const keys = Object.keys(f);
  if (!keys.length) return { ok: true };
  const idChanged = ['name', 'cnic', 'dob'].some(k => k in f && String(f[k] ?? '') !== String(customer[k] instanceof Date ? customer[k].toISOString().slice(0, 10) : customer[k] ?? ''));
  // Identity details are what a check approves: they can't change while a check is open, and changing them after
  // verification means verifying again (the guard in the update makes this safe against a parallel request).
  if (idChanged && ['pending', 'review'].includes(customer.kyc_status)) fail(409, 'KYC_IN_PROGRESS', 'Your identity check is in progress. You can change your name, CNIC or date of birth once it’s finished.');
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (idChanged) sets.push(`kyc_status = case when kyc_status = 'verified' then 'reverify' else kyc_status end`);
  const u = await db.one(`update customers set ${sets.join(', ')} where id = $1 and ($${keys.length + 2} = false or kyc_status not in ('pending', 'review')) returning kyc_status`,
    [customer.id, ...keys.map(k => f[k]), idChanged]);
  if (!u) fail(409, 'KYC_IN_PROGRESS', 'Your identity check is in progress. You can change your name, CNIC or date of birth once it’s finished.');
  const reverify = idChanged && customer.kyc_status === 'verified';
  await audit(db, 'customer:' + customer.id, 'profile.updated', 'customer', customer.id, { fields: keys, reverify });
  return { ok: true, reverify };
});

// Changing the number needs a login from the last 10 minutes (proof of the current number), so a borrowed or stolen
// session can't take the account over. Sales and collections pause for 24 hours afterwards.
const RECENT_LOGIN_MIN = 10;
async function requireRecentLogin(db, customer) {
  const s = await db.one(`select created_at > now() - make_interval(mins => $2) as recent from sessions where token_hash = $1`, [customer.token_hash, RECENT_LOGIN_MIN]);
  if (!s || !s.recent) fail(403, 'REAUTH_REQUIRED', 'For your security, log in again with your current number, then change it.');
}
route('POST', '/me/phone/start', { auth: 'customer' }, async ({ db, customer, body, req }) => {
  const phone = str(body.phone).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  if (!PK_MOBILE.test(phone)) fail(400, 'BAD_PHONE', 'Enter a valid Pakistani mobile number, for example 300 1234567.');
  await requireRecentLogin(db, customer);
  if (!(await turnstile.verify(body.turnstileToken, clientIp(req)))) fail(400, 'HUMAN_CHECK', 'Please complete the check that you’re not a robot.');
  await limit(db, 'phone-change:' + customer.id, 3600, 3, 'Too many attempts. Try again later.');   // before the lookup, so numbers can't be probed
  if (await db.one(`select 1 from customers where phone = $1`, [phone])) fail(409, 'PHONE_IN_USE', 'That number is already used by another PGBX account.');
  await limit(db, 'otp-send-30s:' + phone, 30, 1, 'Please wait a moment before requesting another code.');
  await limit(db, 'otp-send-h:' + phone, 3600, 3, 'Too many codes sent to this number. Try again later.');
  await limit(db, 'otp-send-ip:' + clientIp(req), 600, 5, 'Too many codes requested from this device. Try again later.');
  await otp.send(phone, 'sms');
  return { ok: true };
});
route('POST', '/me/phone/verify', { auth: 'customer' }, async ({ db, customer, body }) => {
  const phone = str(body.phone).replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  const code = str(body.code).replace(/\D/g, '');
  if (!PK_MOBILE.test(phone) || code.length !== 6) fail(400, 'BAD_CODE', 'Enter the 6-digit code you received.');
  await requireRecentLogin(db, customer);
  await limit(db, 'phone-check:' + customer.id, 3600, 10, 'Too many wrong codes. Try again later.');
  if (!(await otp.check(phone, code))) fail(400, 'WRONG_CODE', 'That code is incorrect. Check the SMS and try again.');
  try { await db.query(`update customers set phone = $2, phone_changed_at = now() where id = $1`, [customer.id, phone]); }
  catch (e) { if (e.code === '23505') fail(409, 'PHONE_IN_USE', 'That number is already used by another PGBX account.'); throw e; }
  // Other devices signed in to this account are signed out; this one stays signed in.
  await db.query(`update sessions set revoked_at = now() where customer_id = $1 and token_hash <> $2 and revoked_at is null`, [customer.id, customer.token_hash]);
  await audit(db, 'customer:' + customer.id, 'phone.changed', 'customer', customer.id, {});
  await db.query(`select notify_customer($1, 'security', 'Mobile number changed', $2, null, true)`, [customer.id, `Your account now uses +92 ${phone.slice(0, 3)} ${phone.slice(3)}. For your security, selling gold and collecting bars pause for 24 hours. If this wasn’t you, contact PGBX at once.`]);
  return { ok: true };
});

route('POST', '/devices/push', { auth: 'customer' }, async ({ db, customer, body }) => {
  const token = str(body.token, 400); const platform = ['ios', 'android', 'web'].includes(body.platform) ? body.platform : null;
  if (!token || !platform) fail(400, 'BAD_TOKEN', 'Invalid device.');
  await limit(db, 'push-token:' + customer.id, 3600, 20, 'Too many device registrations. Try again later.');
  await db.query(`insert into push_tokens (token, customer_id, platform) values ($1, $2, $3)
    on conflict (token) do update set customer_id = excluded.customer_id, last_seen_at = now()`, [token, customer.id, platform]);
  // a customer's 5 most recently seen devices receive notifications
  await db.query(`delete from push_tokens where customer_id = $1 and token not in (select token from push_tokens where customer_id = $1 order by last_seen_at desc limit 5)`, [customer.id]);
  return { ok: true };
});

// ---------- identity verification (FR-A2) ----------
route('POST', '/kyc', { auth: 'customer' }, async ({ db, customer }) => {
  if (!kyc.provider) fail(503, 'KYC_OFF', 'Identity verification isn’t available yet.');
  if (customer.kyc_status === 'verified') fail(409, 'KYC_DONE', 'Your identity is already verified.');
  if (customer.kyc_status === 'review') fail(409, 'KYC_IN_PROGRESS', 'A PGBX team member is reviewing your check, usually within one working day.');
  await limit(db, 'kyc-start:' + customer.id, 86400, 10, 'Too many identity checks today. Contact PGBX support.');
  // Only the newest check can be submitted: earlier unfinished ones are closed, so a second check can't change the
  // identity while the first is with a reviewer.
  await db.query(`update kyc_checks set status = 'failed', reason = 'Replaced by a newer check', decided_at = now(), decided_by = 'system' where customer_id = $1 and status = 'started'`, [customer.id]);
  const k = await db.one(`insert into kyc_checks (customer_id, provider) values ($1, $2) returning id, status`, [customer.id, kyc.provider]);
  await db.query(`update customers set kyc_status = 'pending' where id = $1 and kyc_status in ('none', 'failed', 'reverify')`, [customer.id]);
  return { check: k };
});
route('POST', '/kyc/:id/submit', { auth: 'customer' }, async ({ db, customer, body, params }) => {
  if (!['none', 'failed', 'reverify', 'pending'].includes(customer.kyc_status))
    fail(409, customer.kyc_status === 'verified' ? 'KYC_DONE' : 'KYC_IN_PROGRESS', customer.kyc_status === 'verified' ? 'Your identity is already verified.' : 'A PGBX team member is reviewing your check, usually within one working day.');
  const k = await db.one(`select * from kyc_checks where id = $1 and customer_id = $2 and status = 'started'
    and id = (select id from kyc_checks where customer_id = $2 order by created_at desc, id desc limit 1)`, [params.id, customer.id]);
  if (!k) fail(404, 'KYC_NOT_FOUND', 'Start identity verification again.');
  const cnic = str(body.cnic).replace(/\D/g, ''); const name = str(body.name, 100); const dob = str(body.dob, 10); const expiry = str(body.expiry, 10);
  const dobD = isoDate(dob), expD = isoDate(expiry);
  if (cnic.length !== 13 || name.length < 3 || !dobD || !expD) fail(400, 'BAD_KYC', 'Check your CNIC details and try again.');
  if (!(expD > new Date())) fail(400, 'CNIC_EXPIRED', 'Your CNIC has expired. Renew it with NADRA, then verify again.');
  const age = ageOn(dobD);
  if (!(age >= 18 && age < 120)) fail(400, 'UNDER_18', 'You must be 18 or older to use PGBX.');
  let d = await kyc.decide({ name, cnic, dob });
  // One person, one account: a CNIC already verified on another open account always goes to a person to check.
  if (d.status === 'passed' && await db.one(`select 1 from customers where cnic = $1 and id <> $2 and status <> 'closed' and kyc_status in ('verified', 'reverify', 'review')`, [cnicFmt(cnic), customer.id]))
    d = { status: 'review', reason: 'CNIC already used on another account' };
  // The identity a check approves is stored with the check; a reviewer approves exactly these details.
  const ident = { name, cnic: cnicFmt(cnic), dob, expiry };
  let status = { passed: 'verified', failed: 'failed', review: 'review', submitted: 'pending' }[d.status];
  const save = st => db.one(`update customers set name = $2, cnic = $3, dob = $4, kyc_status = $5, kyc_at = case when $5 = 'verified' then now() else kyc_at end
      where id = $1 and kyc_status not in ('review', 'verified') returning id`, [customer.id, name, ident.cnic, dob, st]);
  let saved;
  try { saved = await save(status); }
  catch (e) {                                                      // the same CNIC was verified on another account at the same moment
    if (e.code !== '23505') throw e;
    d = { status: 'review', reason: 'CNIC already used on another account' }; status = 'review'; saved = await save(status);
  }
  if (!saved) fail(409, 'KYC_IN_PROGRESS', 'A PGBX team member is reviewing your check, usually within one working day.');
  await db.query(`update kyc_checks set status = $2, reason = $3, data = $4::jsonb, decided_at = case when $2 in ('passed', 'failed') then now() end, decided_by = $5 where id = $1`,
    [k.id, d.status, d.reason || null, JSON.stringify(ident), kyc.sandbox ? 'provider:sandbox' : null]);
  await audit(db, 'customer:' + customer.id, 'kyc.submitted', 'kyc', k.id, { result: d.status });
  return { status, reason: d.status === 'failed' ? 'We couldn’t verify these details. Check them against your CNIC and try again.' : d.status === 'review' ? 'A PGBX team member will review your check, usually within one working day.' : null };
});

// Identity provider result: body { check_id, status: "passed" | "failed" | "review", reason }, signed with KYC_WEBHOOK_SECRET
route('POST', '/kyc/webhook', {}, async ({ db, raw, body, req }) => {
  if (!signedWebhook(req, raw, kyc.webhookSecret)) fail(401, 'BAD_SIGNATURE', 'Invalid signature.');
  const id = str(body.check_id, 40), status = ['passed', 'failed', 'review'].includes(body.status) ? body.status : null;
  if (!id || !status) fail(400, 'BAD_EVENT', 'Missing fields.');
  const k = await db.one(`select * from kyc_checks where id = $1 and status in ('submitted', 'review')`, [id]);
  if (!k) return { ok: true, status: 'ignored' };                  // unknown or already decided: acknowledged, nothing changes
  await db.query(`update kyc_checks set status = $2, reason = $3, decided_at = case when $2 in ('passed', 'failed') then now() end, decided_by = $4 where id = $1`,
    [id, status, str(body.reason, 300) || null, 'provider:' + kyc.provider]);
  const newest = (await db.one(`select id from kyc_checks where customer_id = $1 order by created_at desc, id desc limit 1`, [k.customer_id])).id === k.id;
  if (newest) {
    const st = { passed: 'verified', failed: 'failed', review: 'review' }[status];
    try { await db.query(`update customers set kyc_status = $2, kyc_at = case when $2 = 'verified' then now() else kyc_at end where id = $1`, [k.customer_id, st]); }
    catch (e) { if (e.code !== '23505') throw e; await db.query(`update customers set kyc_status = 'review' where id = $1`, [k.customer_id]); await db.query(`update kyc_checks set status = 'review', reason = 'CNIC already used on another account' where id = $1`, [id]); }
    if (status !== 'review') await db.query(`select notify_customer($1, 'account', $2, $3, null, true)`, [k.customer_id, status === 'passed' ? 'Identity verified' : 'We couldn’t verify your identity',
      status === 'passed' ? 'You can now buy gold and silver.' : 'Check your CNIC details and try again, or contact PGBX support.']);
  }
  await audit(db, 'provider:' + kyc.provider, 'kyc.decided', 'kyc', id, { decision: status });
  return { ok: true, status };
});

// ---------- buying (FR-B1–B8) ----------
// Unpaid orders, bookings and collections expire on the scheduled sweep; buying and booking also run the expiry
// (at most once a minute per server instance) so limits and slots never wait for the next sweep.
let lastExpiry = 0;
async function expireNow(db) {
  if (Date.now() - lastExpiry < 60000) return;
  lastExpiry = Date.now();
  await db.query(`select fn_expire_orders(), fn_expire_services(), fn_expire_redemptions(), fn_expire_micro()`).catch(e => console.error('PGBX expiry', e.message));
  // The scheduled sweep may run only daily (Vercel Hobby), so pushes also go out here, at most once a minute
  if (push.enabled) await sendPendingPush(db).catch(e => console.error('PGBX push', e.message));
}
// If the payment provider can't start a payment, the order or booking is closed at once instead of holding the
// customer's limit or a visit slot until it expires.
async function startPayment(db, kind, row) {
  try { return await (kind === 'order' ? payments.createIntent(row) : payments.createIntent({ id: row.id, kind, total_pkr: row.fee_pkr ?? row.total_pkr })); }
  catch (e) {
    if (kind === 'order') await db.query(`update orders set status = 'failed', note = 'Payment could not be started' where id = $1 and status = 'pending_payment'`, [row.id]);
    else if (kind === 'micro') {
      await db.query(`update micro_orders set status = 'expired', note = 'Payment could not be started' where id = $1 and status = 'pending_payment'`, [row.id]);
      await db.query(`update micro_txns set status = 'expired' where order_id = $1 and status = 'pending_payment'`, [row.id]);
    }
    else await db.query(`update ${kind === 'appraisal' ? 'appraisals' : 'gift_orders'} set status = 'cancelled', note = 'Payment could not be started' where id = $1 and status = 'pending_payment'`, [row.id]);
    throw e;
  }
}

route('POST', '/locks', { auth: 'customer' }, async ({ db, customer, body, fetchRates }) => {
  await limit(db, 'locks:' + customer.id, 600, 60, 'Too many price checks. Wait a few minutes.');
  const ids = Array.isArray(body.products) ? body.products.map(p => str(p, 40)).filter(Boolean).slice(0, 20) : [];
  await ensureRates(db, fetchRates);
  const l = await db.one(`select * from fn_create_lock($1, $2)`, [customer.id, ids]);
  // expires_in lets the app time the lock with its own clock, even when the phone's clock is wrong
  return { lock: { id: l.id, prices: l.prices, expires_at: l.expires_at, expires_in: Math.max(0, Math.round((new Date(l.expires_at) - Date.now()) / 1000)) } };
});

route('POST', '/orders', { auth: 'customer' }, async ({ db, customer, body }) => {
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, 20).map(l => (l && typeof l === 'object' ? { product_id: str(l.productId || l.product_id, 40), units: int(l.units) } : { product_id: '', units: NaN })) : [];
  if (lines.some(l => !Number.isInteger(l.units))) fail(400, 'BAD_UNITS', MESSAGES.BAD_UNITS[1]);
  const method = ['bank', 'card', 'mwallet'].includes(body.method) ? body.method : fail(400, 'BAD_METHOD', 'Choose a payment method.');
  const key = str(body.idempotencyKey, 80); if (key.length < 8) fail(400, 'BAD_KEY', 'Missing request key.');
  if (!payments.provider) fail(503, 'PAYMENTS_OFF', 'Payments aren’t available yet.');
  await expireNow(db);
  const o = await db.one(`select * from fn_place_order($1, $2, $3::jsonb, $4, $5)`, [customer.id, str(body.lockId, 40), JSON.stringify(lines), method, key]);
  const payment = o.status === 'pending_payment' ? await startPayment(db, 'order', o) : null;
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
    : await db.one(`select * from fn_payment_succeeded('sandbox', $1, $2, $3, '{}')`, ['sbx-' + o.id + (body.attempt ? '-' + str(String(body.attempt), 10) : ''), o.id, body.outcome === 'wrong_amount' ? o.total_pkr - 1 : o.total_pkr]);
  return { order: orderDto(r) };
});

// Provider webhook: body { order_id, provider_ref, amount_pkr, status: "succeeded" | "failed" }, header x-pgbx-signature = HMAC-SHA256(raw body)
// With an x-pgbx-timestamp header (seconds) the signature covers "<timestamp>.<body>" and is accepted for 5 minutes,
// so a captured request can't be replayed later. Without it, the signature covers the body alone.
function signedWebhook(req, raw, secret) {
  const ts = req.headers['x-pgbx-timestamp'];
  if (ts !== undefined) return /^\d{9,11}$/.test(String(ts)) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300 && sec.verifySignature(ts + '.' + raw, req.headers['x-pgbx-signature'], secret);
  return sec.verifySignature(raw, req.headers['x-pgbx-signature'], secret);
}
route('POST', '/payments/webhook', {}, async ({ db, raw, body, req }) => {
  if (!signedWebhook(req, raw, payments.webhookSecret)) fail(401, 'BAD_SIGNATURE', 'Invalid signature.');
  const ref = str(body.provider_ref, 120), orderId = str(body.order_id, 40);
  if (!ref || !orderId) fail(400, 'BAD_EVENT', 'Missing fields.');
  if (body.status === 'succeeded' && !Number.isSafeInteger(body.amount_pkr) && !/^\d{1,12}$/.test(String(body.amount_pkr))) fail(400, 'BAD_EVENT', 'amount_pkr must be a whole number of rupees.');
  // Services (doorstep appraisal fee, gift orders): body.kind = "appraisal" | "gift"
  // Only final results change anything; other provider events (pending, processing…) are acknowledged and ignored.
  if (body.status !== 'succeeded' && body.status !== 'failed') return { ok: true, status: 'ignored' };
  if (body.kind === 'micro') {                                 // $1 gold: order_id is the micro order
    if (body.status !== 'succeeded') return { ok: true, status: 'ignored' };   // it lapses on its own if never paid
    const r = (await db.one(`select fn_micro_paid($1, $2, $3, $4) r`, [orderId, ref, int(body.amount_pkr), payments.provider])).r;
    return { ok: true, status: r.status };
  }
  if (body.kind === 'appraisal' || body.kind === 'gift') {
    if (body.status !== 'succeeded') return { ok: true, status: 'ignored' };
    const r = (await db.one(`select fn_service_paid($1, $2, $3, $4, $5) r`, [body.kind, orderId, ref, int(body.amount_pkr), payments.provider])).r;
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
    where customer_id = $1 and created_at >= $2::date and created_at < $3::date + 1 order by created_at limit 5000`, [customer.id, from, to]);
  const opening = await db.query(`select product_id, sum(delta)::int units from ledger where customer_id = $1 and created_at < $2::date group by 1 having sum(delta) <> 0`, [customer.id, from]);
  return { from, to, opening, entries };
});

// ---------- collection at a dealer (FR-D1–D9) ----------
const PHONE_HOLD_MS = 24 * 3600e3;
function phoneHold(customer) {
  if (customer.phone_changed_at && Date.now() - new Date(customer.phone_changed_at) < PHONE_HOLD_MS)
    fail(403, 'PHONE_RECENTLY_CHANGED', 'Your mobile number changed in the last 24 hours. For your security, selling and collecting are paused until then.');
}
// Value created by sandbox payments is test money: it is never paid out or handed over as real gold.
const sandboxFunds = async (db, customerId) => !!(await db.one(`select 1 from payments p join orders o on o.id = p.order_id where o.customer_id = $1 and p.provider = 'sandbox'
  union all select 1 from service_payments sp join micro_orders m on m.id = sp.entity_id where sp.kind = 'micro' and m.customer_id = $1 and sp.provider = 'sandbox' limit 1`, [customerId]));
route('POST', '/redemptions', { auth: 'customer' }, async ({ db, customer, body }) => {
  phoneHold(customer);
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
route('GET', '/alerts', { auth: 'customer' }, async ({ db, customer }) => ({ alerts: await db.query(`select id, metal, dir, target_pkr, active, fired_at from price_alerts where customer_id = $1 order by active desc, created_at desc limit 100`, [customer.id]) }));
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
  const items = Array.isArray(body.items) ? body.items.filter(i => i && typeof i === 'object').slice(0, 20).map(i => ({
    metal: i.metal === 'silver' ? 'silver' : 'gold', karat: str(i.karat, 8), approx_g: Math.max(0, Math.min(100000, Number(i.approx_g) || 0)), note: str(i.note, 80) })) : [];
  const phone = cleanPhone(body.phone);
  if (!PK_MOBILE.test(phone)) fail(400, 'BAD_PHONE', 'Enter a valid Pakistani mobile number, for example 300 1234567.');
  await limit(db, 'appraisal:' + customer.id, 86400, 5, 'You’ve booked several visits today. Contact PGBX support for more.');
  await expireNow(db);
  const a = await db.one(`select * from fn_book_appraisal($1, $2, $3, $4, $5, $6::date, $7, $8::jsonb, $9, $10)`,
    [customer.id, str(body.city, 40), str(body.area, 80), str(body.address, 300), phone, str(body.date, 10), str(body.slot, 20), JSON.stringify(items), str(body.notes, 300), String(sec.newCode()).slice(0, 4)]);
  return { appraisal: appraisalDto(a), payment: await startPayment(db, 'appraisal', a) };
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
  await limit(db, 'gift:' + customer.id, 86400, 10, 'You’ve placed several gift orders today. Contact PGBX support for more.');
  await expireNow(db);
  await ensureRates(db, fetchRates);
  const g = await db.one(`select * from fn_place_gift($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date)`,
    [customer.id, str(body.item, 20), str(body.shape, 10), str(body.design, 20), str(body.engraving, 40), str(body.message, 200), str(body.packaging, 20),
      str(body.recipientName, 100), phone, str(body.recipientCity, 40), str(body.recipientAddress, 300), str(body.deliverBy, 10)]);
  return { gift: giftDto(g), payment: await startPayment(db, 'gift', g) };
});
route('GET', '/gifts', { auth: 'customer' }, async ({ db, customer }) =>
  ({ gifts: (await db.query(`select * from gift_orders where customer_id = $1 and (status <> 'pending_payment' or created_at > now() - interval '1 hour') order by created_at desc limit 50`, [customer.id])).map(giftDto) }));
route('POST', '/gifts/:id/cancel', { auth: 'customer' }, async ({ db, customer, params }) => ({ gift: giftDto(await db.one(`select * from fn_cancel_gift($1, $2)`, [customer.id, params.id])) }));

// Sandbox only: pays a booking or gift order the way a provider webhook would
route('POST', '/payments/sandbox/:kind/:id', { auth: 'customer' }, async ({ db, customer, params }) => {
  if (!payments.sandbox) fail(404, 'NOT_FOUND', 'Not found.');
  const table = { appraisal: 'appraisals', gift: 'gift_orders', micro: 'micro_orders' }[params.kind];
  if (!table) fail(404, 'NOT_FOUND', 'Not found.');
  const row = await db.one(`select * from ${table} where id = $1 and customer_id = $2`, [params.id, customer.id]);
  if (!row) fail(404, 'NOT_FOUND', 'Not found.');
  if (params.kind === 'micro') return { status: (await db.one(`select fn_micro_paid($1, $2, $3, 'sandbox') r`, [row.id, 'sbx-' + row.id, row.total_pkr])).r.status };
  const r = (await db.one(`select fn_service_paid($1, $2, $3, $4, 'sandbox') r`, [params.kind, row.id, 'sbx-' + row.id, row.fee_pkr ?? row.total_pkr])).r;
  return { status: r.status };
});

// ---------- $1 gold: buy a dollar at a time, sell any amount held ----------
const microTxnDto = t => ({ ref: t.ref, side: t.side, amount_pkr: t.amount_pkr, grams: Number(t.grams), price_gram: Number(t.price_gram), usd: t.usd === null ? null : Number(t.usd),
  status: t.status, created_at: t.created_at, credited_at: t.credited_at, paid_out_at: t.paid_out_at, payout_to: t.payout_to ? '•••• ' + t.payout_to.slice(-4) : null,
  order_ref: t.order_ref || null, lots: t.lots || [] });
const lotsOf = `(select coalesce(json_agg(json_build_object('ref', l.ref, 'grams', a.grams::float8, 'status', l.status) order by l.no), '[]')
  from lot_allocations a join tola_lots l on l.id = a.lot_id where a.txn_id = t.id)`;

// Today's price of $1 of gold (public, so guests can see it)
route('GET', '/micro/quote', {}, async ({ db, fetchRates }) => {
  await ensureRates(db, fetchRates).catch(() => {});
  const set = await settingsMap(db);
  const s = await db.one(`select *, extract(epoch from now() - fetched_at) as age from rate_snapshots order by id desc limit 1`);
  const fresh = !!s && s.usd_pkr !== null && s.age < Number(set.rate_stale_seconds);
  const usd = Number(set.micro_usd), usdPkr = s && s.usd_pkr !== null ? Number(s.usd_pkr) : null;
  const buyGram = s ? Math.round(s.gold_buy_tola / TOLA * 100) / 100 : null, sellGram = s ? Math.round(s.gold_sell_tola / TOLA * 100) / 100 : null;
  const unitPkr = usdPkr ? Math.round(usd * usdPkr) : null;
  return { quote: { usd, usdPkr, unitPkr, buyGram, sellGram, gramsPerUnit: unitPkr && buyGram ? Math.round(unitPkr / buyGram * 1e6) / 1e6 : null,
    unitsPerTola: unitPkr && buyGram ? Math.ceil(TOLA / (unitPkr / buyGram)) : null, maxUnits: Number(set.micro_max_units), minSellGrams: Number(set.micro_min_sell_g),
    fresh, at: s ? s.fetched_at : null } };
});
route('GET', '/micro', { auth: 'customer' }, async ({ db, customer }) => {
  const snap = await db.one(`select gold_sell_tola from rate_snapshots order by id desc limit 1`);
  const grams = Number((await db.one(`select micro_grams($1) g`, [customer.id])).g);
  const txns = await db.query(`select t.*, o.ref as order_ref, ${lotsOf} as lots from micro_txns t left join micro_orders o on o.id = t.order_id
    where t.customer_id = $1 and (t.side = 'sell' or t.status in ('credited', 'refund_due') or t.created_at > now() - interval '1 hour') order by t.created_at desc, t.ref limit 300`, [customer.id]);
  const orders = await db.query(`select id, ref, units, unit_pkr, total_pkr, status, note, created_at from micro_orders where customer_id = $1 order by created_at desc limit 50`, [customer.id]);
  return { gold: { grams, value_pkr: snap ? Math.floor(grams * Math.round(snap.gold_sell_tola / TOLA * 100) / 100) : null }, transactions: txns.map(microTxnDto), orders };
});
route('POST', '/micro/buy', { auth: 'customer' }, async ({ db, customer, body, fetchRates }) => {
  if (!payments.provider) fail(503, 'PAYMENTS_OFF', 'Payments aren’t available yet.');
  const units = int(body.units); if (!Number.isInteger(units)) fail(400, 'BAD_UNITS', 'Choose how many dollars of gold to buy.');
  const key = str(body.idempotencyKey, 80); if (key.length < 8) fail(400, 'BAD_KEY', 'Missing request key.');
  await limit(db, 'micro-buy:' + customer.id, 600, 60, 'Too many purchases in a few minutes. Wait a moment and try again.');
  await expireNow(db);
  await ensureRates(db, fetchRates);
  const o = await db.one(`select * from fn_micro_buy($1, $2, $3)`, [customer.id, units, key]);
  const payment = o.status === 'pending_payment' ? await startPayment(db, 'micro', o) : null;
  return { order: { id: o.id, ref: o.ref, units: o.units, unit_pkr: o.unit_pkr, total_pkr: o.total_pkr, usd_pkr: Number(o.usd_pkr), status: o.status }, payment };
});
route('POST', '/micro/sell', { auth: 'customer' }, async ({ db, customer, body, fetchRates }) => {
  const grams = typeof body.grams === 'number' ? body.grams : Number(str(String(body.grams ?? ''), 20));
  if (!(grams > 0) || !Number.isFinite(grams)) fail(400, 'BAD_GRAMS', MESSAGES.BAD_GRAMS[1]);
  const iban = str(body.iban, 40).replace(/\s/g, '').toUpperCase();
  const key = str(body.idempotencyKey, 80); if (key.length < 8) fail(400, 'BAD_KEY', 'Missing request key.');
  phoneHold(customer);
  await limit(db, 'micro-sell:' + customer.id, 3600, 30, 'Too many sales in an hour. Try again later.');
  await ensureRates(db, fetchRates);
  // The customer confirmed an amount; if the price has since moved down by more than 0.2%, ask them to confirm again
  const expected = int(body.expectedAmountPkr);
  if (Number.isSafeInteger(expected) && expected > 0) {
    const snap = await db.one(`select round(gold_sell_tola / 11.664, 2)::float8 g from rate_snapshots order by id desc limit 1`);
    const now = snap ? Math.max(1, Math.floor(Math.round(grams * 1e6) / 1e6 * snap.g)) : 0;
    if (now < expected - Math.max(1, Math.floor(expected * 0.002))) fail(409, 'PRICE_CHANGED', `The price changed. You would now receive Rs ${now.toLocaleString('en-US')}. Check and confirm again.`, { amountPkr: now });
  }
  const t = await db.one(`select * from fn_micro_sell($1, $2, $3, $4)`, [customer.id, grams, iban, key]);
  return { transaction: microTxnDto((await db.one(`select t.*, ${lotsOf} as lots from micro_txns t where t.id = $1`, [t.id]))) };
});
// One transaction by its ID, with the tola lot(s) it is part of
route('GET', '/micro/txns/:ref', { auth: 'customer' }, async ({ db, customer, params }) => {
  const t = await db.one(`select t.*, o.ref as order_ref, ${lotsOf} as lots from micro_txns t left join micro_orders o on o.id = t.order_id where t.ref = $1 and t.customer_id = $2`, [params.ref.toUpperCase(), customer.id]);
  if (!t) fail(404, 'NOT_FOUND', 'No transaction with that ID on your account.');
  return { transaction: microTxnDto(t) };
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
  if ((await db.one(`select rate_hits($1, 900) n`, ['staff-fail:' + email])).n >= 8) fail(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in 15 minutes.');
  const s = await db.one(`select * from staff where email = $1 and active`, [email]);
  const ok = s ? sec.verifyPassword(str(body.password, 200), s.password_hash) : (sec.verifyPassword('x', DUMMY_HASH), false);  // one scrypt either way
  if (!ok) {
    await limit(db, 'staff-fail:' + email, 900, 1000);
    await audit(db, 'system', 'staff.login_failed', 'staff', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '[not an email]', { ip: clientIp(req) });
    fail(401, 'BAD_LOGIN', 'Email or password is incorrect.');
  }
  const token = sec.newToken();
  await db.query(`insert into staff_sessions (token_hash, staff_id, expires_at) values ($1, $2, now() + interval '12 hours')`, [sec.hashToken(token), s.id]);
  if (body.cookie === false) return { token, mfaRequired: true };   // scripts and tests; the panels use the HttpOnly cookie
  setCookie(res, 'pgbx_staff', token, 12 * 3600);
  return { mfaRequired: true };
});
route('POST', '/staff/mfa', { staff: { preMfa: true } }, async ({ db, staff, body, req }) => {
  await limit(db, 'staff-mfa:' + staff.id, 900, 6, 'Too many wrong codes. Sign in again in 15 minutes.');
  const step = sec.totpStep(staff.totp_secret, body.code);
  // Each code works once: the update only succeeds for a time step later than the last one accepted.
  const fresh = step !== null && await db.one(`update staff set totp_last_step = $2 where id = $1 and totp_last_step < $2 returning id`, [staff.id, step]);
  if (!fresh) { await audit(db, 'staff:' + staff.id, 'staff.mfa_failed', 'staff', staff.id, { ip: clientIp(req), reused: step !== null }); fail(401, 'BAD_CODE', step !== null ? 'That code was already used. Wait for the next code in your authenticator app.' : 'That code is incorrect. Use the current code from your authenticator app.'); }
  await db.query(`update staff_sessions set mfa_passed = true where token_hash = $1`, [staff.token_hash]);
  await audit(db, 'staff:' + staff.id, 'staff.login', 'staff', staff.id, { ip: clientIp(req) });
  return { ok: true, staff: { name: staff.name, role: staff.role, dealer_id: staff.dealer_id }, mustChangePassword: staff.must_change_password };
});
route('POST', '/staff/password', { staff: { beforePasswordChange: true } }, async ({ db, staff, body, req }) => {
  await limit(db, 'staff-pw:' + staff.id, 900, 5, 'Too many attempts. Try again in 15 minutes.');
  const next = typeof body.next === 'string' ? body.next : '';
  if (!sec.verifyPassword(str(body.current, 200), staff.password_hash)) fail(400, 'BAD_PASSWORD', 'Your current password is incorrect.');
  if (next.length < 12 || next.length > 200) fail(400, 'WEAK_PASSWORD', 'Use at least 12 characters for the new password.');
  if (next === body.current || next.toLowerCase().includes(staff.email.split('@')[0])) fail(400, 'WEAK_PASSWORD', 'Choose a new password that isn’t your old one or your email.');
  await db.query(`update staff set password_hash = $2, must_change_password = false where id = $1`, [staff.id, sec.hashPassword(next)]);
  await db.query(`update staff_sessions set revoked_at = now() where staff_id = $1 and token_hash <> $2 and revoked_at is null`, [staff.id, staff.token_hash]);
  await audit(db, 'staff:' + staff.id, 'staff.password_changed', 'staff', staff.id, { ip: clientIp(req) });
  return { ok: true };
});
route('POST', '/staff/logout', { staff: { preMfa: true, beforePasswordChange: true } }, async ({ db, staff, res }) => {
  await db.query(`update staff_sessions set revoked_at = now() where token_hash = $1`, [staff.token_hash]);
  setCookie(res, 'pgbx_staff', '', 0);
  return { ok: true };
});
route('GET', '/staff/me', { staff: { beforePasswordChange: true } }, async ({ db, staff }) => {
  const dealer = staff.dealer_id ? await db.one(`select id, name, area from dealers where id = $1`, [staff.dealer_id]) : null;
  return { staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, dealer, mustChangePassword: staff.must_change_password } };
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
  const r = await db.one(`select customer_id from redemptions where id = $1 and dealer_id = $2`, [params.id, staff.dealer_id]);
  if (r && process.env.VERCEL_ENV === 'production' && await sandboxFunds(db, r.customer_id))
    fail(409, 'SANDBOX_FUNDS', 'This customer’s metal came from test (sandbox) payments. Do not hand over; contact PGBX operations.');
  const serials = Array.isArray(body.serials) ? body.serials.map(s => str(s, 60).toUpperCase()) : [];
  return { redemption: await db.one(`select id, status, serials from fn_dealer_handover($1, $2, $3, $4)`, [staff.id, params.id, serials, body.cnicChecked === true]) };
});
route('GET', '/dealer/stock', dealerOnly, async ({ db, staff }) =>
  ({ stock: await db.query(`select s.product_id, p.label, p.metal, s.units, s.updated_at from dealer_stock s join products p on p.id = s.product_id where s.dealer_id = $1 order by p.sort`, [staff.dealer_id]) }));

// ---------- admin panel (FR-M1–M10) ----------
const ops = { staff: { roles: ['admin', 'ops'] } };
const adminOnly = { staff: { roles: ['admin'] } };
route('GET', '/admin/overview', ops, async ({ db }) => ({
  ...(await db.one(`select
    (select count(*)::int from customers where status = 'active') customers,
    (select count(*)::int from customers where kyc_status = 'verified' and status = 'active') verified,
    (select count(*)::int from kyc_checks where status in ('review', 'submitted')) kyc_review,
    (select count(*)::int from orders where status = 'flagged') flagged_orders,
    (select coalesce(sum(total_pkr), 0) from orders where status = 'credited' and credited_at >= pk_day_start()) sales_today_pkr,
    (select count(*)::int from orders where status = 'credited' and credited_at >= pk_day_start()) orders_today,
    (select count(*)::int from redemptions where status in ('requested', 'ready') and expires_at > now()) active_collections,
    (select count(*)::int from appraisals where status = 'booked') appraisals_to_assign,
    (select count(*)::int from gift_orders where status in ('placed', 'in_production', 'dispatched')) gifts_open,
    (select count(*)::int from tola_lots where status = 'full') lots_to_settle,
    (select count(*)::int from micro_txns where status = 'pending_payout') payouts_pending,
    (select count(*)::int from refunds where status = 'due') refunds_due,
    (select count(*)::int from support_requests where status = 'open') support_open`)),
  rates: await db.one(`select gold_buy_tola, gold_sell_tola, silver_buy_tola, silver_sell_tola, source, fetched_at from rate_snapshots order by id desc limit 1`),
  sandbox: payments.sandbox || kyc.sandbox,
}));

// What each setting may hold. A wrong value here would break buying or services for everyone, so every change is
// checked against its type and a sensible range before it is saved.
const isInt = (min, max) => v => Number.isInteger(v) && v >= min && v <= max;
const orNull = f => v => v === null || f(v);
const objOf = (keys, f) => v => v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => f(v[k])) && Object.keys(v).every(k => keys.includes(k));
const listOf = (f, max = 30) => v => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(f) && new Set(v).size === v.length;
const isName = v => typeof v === 'string' && /^[A-Za-z][A-Za-z .'-]{1,39}$/.test(v);
const isSlot = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v) && v.slice(0, 5) < v.slice(6);
const frac = (min, max) => v => typeof v === 'number' && v >= min && v <= max;
const SETTING_RULES = {
  max_units_per_order: isInt(1, 1000), daily_limit_pkr: isInt(1000, 1e9), price_lock_seconds: isInt(15, 600), rate_stale_seconds: isInt(10, 600),
  redemption_valid_hours: isInt(1, 720), order_payment_minutes: isInt(5, 1440), session_days: isInt(1, 365),
  spread: objOf(['gold', 'silver'], frac(0, 0.2)), retention_days: orNull(isInt(30, 36500)), redemption_fee_pkr: orNull(isInt(0, 1e6)), min_purchase_pkr: orNull(isInt(0, 1e8)),
  purity: v => objOf(['gold', 'silver'], m => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length >= 1 && Object.entries(m).every(([k, x]) => /^[0-9A-Za-z]{2,4}$/.test(k) && frac(0.3, 1)(x)))(v),
  buyback_deduction_pct: objOf(['gold', 'silver'], frac(0, 50)), appraisal_fee_pkr: isInt(0, 1e6), appraisal_cities: listOf(isName), appraisal_slots: listOf(isSlot, 12),
  appraisal_free_cancel_hours: isInt(0, 720), gift_making_pkr: objOf(['plain', 'themed', 'engraving'], isInt(0, 1e7)), gift_packaging_pkr: objOf(['standard', 'premium'], isInt(0, 1e7)),
  gift_delivery_pkr: isInt(0, 1e6), gift_lead_days: isInt(1, 60), gift_cities: listOf(isName, 60),
  micro_usd: frac(0.5, 100), micro_max_units: isInt(1, 1000), micro_min_sell_g: frac(0.0001, 11.664),
};

route('GET', '/admin/settings', ops, async ({ db }) => ({ settings: await db.query(`select key, value, updated_at, updated_by from settings order by key`) }));
route('PATCH', '/admin/settings', adminOnly, async ({ db, staff, body }) => {
  const known = new Set((await db.query(`select key from settings`)).map(r => r.key));
  const entries = Object.entries(body || {});
  for (const [k, v] of entries) {                              // check everything first, so a bad value saves nothing
    if (!known.has(k)) fail(400, 'BAD_SETTING', `Unknown setting ${k}.`);
    if (!SETTING_RULES[k] || !SETTING_RULES[k](v)) fail(400, 'BAD_SETTING', `That value for ${k} isn’t allowed. Check the format and range.`);
  }
  if (!entries.length) return { ok: true };
  // all keys in one statement: either every change is saved or none is
  await db.query(`update settings s set value = j.value, updated_at = now(), updated_by = $2 from jsonb_each($1::jsonb) j where s.key = j.key`, [JSON.stringify(Object.fromEntries(entries)), 'staff:' + staff.id]);
  for (const [k, v] of entries) await audit(db, 'staff:' + staff.id, 'setting.changed', 'setting', k, { value: v });
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
  if (await db.one(`select 1 from dealers where id = $1`, [id])) fail(409, 'DEALER_EXISTS', 'A dealer with that ID already exists. Choose another ID.');
  const lat = Number(body.lat), lng = Number(body.lng);
  if ((body.lat != null && body.lat !== '' && !(lat >= 23 && lat <= 37.5)) || (body.lng != null && body.lng !== '' && !(lng >= 60 && lng <= 78))) fail(400, 'BAD_DEALER', 'The map position must be in Pakistan.');
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

route('GET', '/admin/customers', ops, async ({ db, query, staff }) => {
  const q = str(query.q || '', 60);
  const where = `$1 = '' or phone like '%' || $1 || '%' or lower(name) like '%' || lower($1) || '%' or replace(cnic, '-', '') like '%' || replace($1, '-', '') || '%'`;
  const rows = await db.query(`select id, phone, name, cnic, kyc_status, status, created_at from customers where ${where} order by created_at desc limit 50`, [q]);
  if (q) await audit(db, 'staff:' + staff.id, 'customer.searched', 'customer', null, { q, results: rows.length });   // who searched personal data
  return { customers: rows, total: (await db.one(`select count(*)::int n from customers where ${where}`, [q])).n };
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
  const open = ['review', 'submitted'].includes(status);
  // The identity shown is the one submitted with the check (what a reviewer approves), not the current profile
  return { checks: await db.query(`select k.id, k.customer_id, coalesce(k.data ->> 'name', c.name) as name, coalesce(k.data ->> 'cnic', c.cnic) as cnic, k.data ->> 'dob' as dob, c.phone,
      k.provider, k.status, k.reason, k.created_at from kyc_checks k join customers c on c.id = k.customer_id where k.status = $1 order by ${open ? 'k.created_at' : 'k.decided_at desc nulls last'} limit 200`, [status]),
    total: (await db.one(`select count(*)::int n from kyc_checks where status = $1`, [status])).n };
});
route('POST', '/admin/kyc/:id/decide', ops, async ({ db, staff, params, body }) => {
  const decision = ['passed', 'failed'].includes(body.decision) ? body.decision : fail(400, 'BAD_DECISION', 'Choose pass or fail.');
  const k = await db.one(`select * from kyc_checks where id = $1 and status in ('review', 'submitted')`, [params.id]);
  if (!k) fail(404, 'NOT_FOUND', 'This check is no longer waiting for review.');
  const newest = (await db.one(`select id from kyc_checks where customer_id = $1 order by created_at desc, id desc limit 1`, [k.customer_id])).id === k.id;
  if (newest) {
    const id = k.data || {};
    try {
      await db.query(`update customers set kyc_status = $2, kyc_at = case when $2 = 'verified' then now() else kyc_at end,
          name = coalesce($3, name), cnic = coalesce($4, cnic), dob = coalesce($5::date, dob) where id = $1`,
        [k.customer_id, decision === 'passed' ? 'verified' : 'failed', id.name || null, id.cnic || null, id.dob || null]);
    } catch (e) {
      if (e.code === '23505') fail(409, 'CNIC_IN_USE', 'This CNIC is already verified on another open account. Close or suspend that account first.');
      throw e;
    }
  }
  await db.query(`update kyc_checks set status = $2, reason = $3, decided_at = now(), decided_by = $4 where id = $1`, [k.id, decision, str(body.reason, 300) || null, 'staff:' + staff.id]);
  await db.query(`select notify_customer($1, 'account', $2, $3, null, true)`, [k.customer_id, decision === 'passed' ? 'Identity verified' : 'We couldn’t verify your identity',
    decision === 'passed' ? 'You can now buy gold and silver.' : 'Check your CNIC details and try again, or contact PGBX support.']);
  await audit(db, 'staff:' + staff.id, 'kyc.decided', 'kyc', params.id, { decision, reason: body.reason || null });
  return { ok: true };
});

route('GET', '/admin/orders', ops, async ({ db, query }) => {
  const status = ['flagged', 'pending_payment', 'credited', 'refunded', 'failed', 'expired'].includes(query.status) ? query.status : 'flagged';
  return { orders: await db.query(`select o.id, o.receipt_no, o.status, o.total_pkr, o.note, o.created_at, o.paid_at, c.name, c.phone from orders o join customers c on c.id = o.customer_id where o.status = $1 order by o.created_at desc limit 200`, [status]),
    total: (await db.one(`select count(*)::int n from orders where status = $1`, [status])).n };
});
route('POST', '/admin/orders/:id/resolve', ops, async ({ db, staff, params, body }) =>
  ({ order: orderDto(await db.one(`select * from fn_resolve_order($1, $2, $3, $4)`, [staff.id, params.id, str(body.action, 10), str(body.note, 300) || null])) }));

route('GET', '/admin/reconciliation', ops, async ({ db, query }) => {
  const day = isoDate(query.day) ? query.day : new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);   // today in Pakistan (UTC+5, no DST)
  return { reconciliation: (await db.one(`select fn_reconcile($1::date) as r`, [day])).r };
});
route('POST', '/admin/vault', ops, async ({ db, staff, body }) => {
  const units = int(body.units); if (!(units >= 0 && units <= 1e6)) fail(400, 'BAD_UNITS', 'Enter 0 or more units.');
  if (!(await db.one(`select 1 from products where id = $1`, [str(body.product_id, 40)]))) fail(400, 'UNKNOWN_PRODUCT', MESSAGES.UNKNOWN_PRODUCT[1]);
  await db.query(`insert into vault_counts (product_id, units, counted_by, note) values ($1, $2, $3, $4)`, [str(body.product_id, 40), units, 'staff:' + staff.id, str(body.note, 200) || null]);
  await audit(db, 'staff:' + staff.id, 'vault.counted', 'product', body.product_id, { units });
  return { ok: true };
});

route('GET', '/admin/support', ops, async ({ db, query }) => {
  const status = query.status === 'closed' ? 'closed' : 'open';
  return { requests: await db.query(`select s.id, s.topic, s.body, s.status, s.created_at, s.closed_at, s.closed_by, c.id as customer_id, c.name, c.phone
    from support_requests s left join customers c on c.id = s.customer_id where s.status = $1 order by s.created_at desc limit 200`, [status]),
    total: (await db.one(`select count(*)::int n from support_requests where status = $1`, [status])).n };
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
  const open = ['booked', 'confirmed'].includes(status);         // to do: soonest visit first; done: newest first
  return { appraisals: (await db.query(`select a.*, c.name as customer_name from appraisals a join customers c on c.id = a.customer_id where a.status = $1
      order by ${open ? 'a.visit_date, a.slot' : 'a.updated_at desc'} limit 200`, [status]))
    .map(a => ({ ...appraisalDto(a), customer_name: a.customer_name })), total: (await db.one(`select count(*)::int n from appraisals where status = $1`, [status])).n };
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
  const open = ['placed', 'in_production', 'dispatched'].includes(status);
  return { gifts: (await db.query(`select g.*, c.name as customer_name, i.label as item_label, i.metal from gift_orders g join customers c on c.id = g.customer_id join gift_items i on i.id = g.item_id
    where g.status = $1 order by ${open ? 'g.deliver_by' : 'g.updated_at desc'} limit 200`, [status])).map(g => ({ ...giftDto(g), customer_name: g.customer_name, item_label: g.item_label, metal: g.metal })),
    total: (await db.one(`select count(*)::int n from gift_orders where status = $1`, [status])).n };
});
route('POST', '/admin/gifts/:id', ops, async ({ db, staff, params, body }) => {
  const action = ['produce', 'dispatch', 'deliver', 'cancel'].includes(body.action) ? body.action : fail(400, 'BAD_ACTION', MESSAGES.BAD_ACTION[1]);
  const data = { tracking: str(body.tracking, 60) || undefined, reason: str(body.reason, 300) || undefined };
  return { gift: giftDto(await db.one(`select * from fn_gift_update($1, $2, $3, $4::jsonb)`, [staff.id, params.id, action, JSON.stringify(data)])) };
});

// $1 gold: tola lots, finding any transaction ID, and payouts for sales
const lotDto = l => ({ id: l.id, ref: l.ref, side: l.side, no: l.no, grams_target: Number(l.grams_target), grams_filled: Number(l.grams_filled), status: l.status,
  created_at: l.created_at, filled_at: l.filled_at, settled_at: l.settled_at, settled_by: l.settled_by, bar_serial: l.bar_serial, settle_note: l.settle_note, transactions: l.n ?? undefined, amount_pkr: l.amount ?? undefined });
route('GET', '/admin/micro/lots', ops, async ({ db, query }) => {
  const side = query.side === 'sell' ? 'sell' : 'buy';
  const status = ['filling', 'full', 'settled'].includes(query.status) ? query.status : null;
  const rows = await db.query(`select l.*, (select count(*)::int from lot_allocations a where a.lot_id = l.id) n,
      (select coalesce(round(sum(a.amount_pkr)), 0)::bigint from lot_allocations a where a.lot_id = l.id) amount
    from tola_lots l where l.side = $1 and ($2::text is null or l.status = $2) order by l.no desc limit 200`, [side, status]);
  const totals = await db.one(`select (select coalesce(sum(grams), 0)::float8 from micro_txns where side = 'buy' and status = 'credited') bought,
    (select coalesce(sum(grams), 0)::float8 from micro_txns where side = 'sell') sold`);
  return { lots: rows.map(lotDto), totals: { ...totals, held: Math.round((totals.bought - totals.sold) * 1e6) / 1e6 } };
});
route('GET', '/admin/micro/lots/:ref', ops, async ({ db, params, query }) => {
  const l = await db.one(`select * from tola_lots where ref = $1`, [params.ref.toUpperCase()]);
  if (!l) fail(404, 'NOT_FOUND', 'No lot with that ID.');
  const page = Math.max(0, int(query.page) || 0);
  const rows = await db.query(`select t.ref, t.side, t.amount_pkr, t.price_gram::float8 price_gram, t.created_at, a.grams::float8 grams, t.grams::float8 txn_grams, c.name, c.phone
    from lot_allocations a join micro_txns t on t.id = a.txn_id join customers c on c.id = t.customer_id where a.lot_id = $1 order by t.credited_at nulls last, t.created_at, t.ref limit 500 offset $2`, [l.id, page * 500]);
  const n = (await db.one(`select count(*)::int n from lot_allocations where lot_id = $1`, [l.id])).n;
  return { lot: { ...lotDto(l), transactions: n }, transactions: rows, page, pages: Math.ceil(n / 500) };
});
// Plain-text list of every transaction ID in a lot, for the records
route('GET', '/admin/micro/lots/:ref/ids', ops, async ({ db, params, staff }) => {
  const l = await db.one(`select * from tola_lots where ref = $1`, [params.ref.toUpperCase()]);
  if (!l) fail(404, 'NOT_FOUND', 'No lot with that ID.');
  const rows = await db.query(`select t.ref, a.grams::float8 grams from lot_allocations a join micro_txns t on t.id = a.txn_id where a.lot_id = $1 order by t.credited_at nulls last, t.created_at, t.ref`, [l.id]);
  await audit(db, 'staff:' + staff.id, 'lot.exported', 'lot', l.ref, { count: rows.length });
  return { lot: l.ref, status: l.status, bar_serial: l.bar_serial, grams: Number(l.grams_filled), ids: rows.map(r => `${r.ref}\t${r.grams.toFixed(6)}`) };
});
route('GET', '/admin/micro/find', ops, async ({ db, query }) => {
  const ref = str(query.ref || '', 40).toUpperCase();
  if (ref.length < 6) fail(400, 'BAD_REF', 'Enter a transaction or lot ID.');
  const lot = await db.one(`select * from tola_lots where ref = $1`, [ref]);
  if (lot) return { lot: lotDto(lot) };
  const t = await db.one(`select t.*, o.ref as order_ref, c.name, c.phone, c.id as cid, ${lotsOf} as lots from micro_txns t left join micro_orders o on o.id = t.order_id join customers c on c.id = t.customer_id where t.ref = $1`, [ref]);
  if (t) return { transaction: { ...microTxnDto(t), payout_to: t.payout_to, customer: { id: t.cid, name: t.name, phone: t.phone } } };
  const o = await db.one(`select o.*, c.name, c.phone from micro_orders o join customers c on c.id = o.customer_id where o.ref = $1`, [ref]);
  if (o) return { order: { ref: o.ref, units: o.units, total_pkr: o.total_pkr, status: o.status, note: o.note, payment_ref: o.payment_ref, created_at: o.created_at, customer: { id: o.customer_id, name: o.name, phone: o.phone },
    transactions: (await db.query(`select t.ref from micro_txns t where order_id = $1 order by t.ref`, [o.id])).map(r => r.ref) } };
  fail(404, 'NOT_FOUND', 'No transaction, order or lot with that ID.');
});
route('POST', '/admin/micro/lots/:id/settle', ops, async ({ db, staff, params, body }) =>
  ({ lot: lotDto(await db.one(`select * from fn_lot_settle($1, $2, $3, $4)`, [staff.id, int(params.id), str(body.serial, 60), str(body.note, 300) || null])) }));
route('GET', '/admin/micro/payouts', ops, async ({ db, query }) => {
  const status = query.status === 'paid_out' ? 'paid_out' : 'pending_payout';
  const rows = await db.query(`select t.id, t.ref, t.amount_pkr, t.grams::float8 grams, t.payout_to, t.payout_ref, t.paid_out_at, t.created_at, c.name, c.phone, c.id as customer_id,
      exists (select 1 from service_payments sp join micro_orders m on m.id = sp.entity_id where sp.kind = 'micro' and m.customer_id = c.id and sp.provider = 'sandbox') as sandbox
    from micro_txns t join customers c on c.id = t.customer_id where t.side = 'sell' and t.status = $1
    order by ${status === 'pending_payout' ? 't.created_at' : 't.paid_out_at desc'} limit 300`, [status]);   // to send: oldest first; sent: newest first
  return { payouts: rows, total: (await db.one(`select count(*)::int n from micro_txns where side = 'sell' and status = $1`, [status])).n };
});
route('POST', '/admin/micro/payouts/:id', ops, async ({ db, staff, params, body }) => {
  const t = await db.one(`select customer_id from micro_txns where id = $1`, [params.id]);
  if (t && await sandboxFunds(db, t.customer_id) && process.env.VERCEL_ENV === 'production')
    fail(409, 'SANDBOX_FUNDS', 'This customer’s gold came from test (sandbox) payments. Don’t send money; check with an administrator.');
  return { payout: microTxnDto(await db.one(`select * from fn_micro_payout($1, $2, $3)`, [staff.id, params.id, str(body.ref, 80)])) };
});
// One queue for every refund owed: orders, $1 gold, appraisals and gifts
route('GET', '/admin/refunds', ops, async ({ db, query }) => {
  const status = query.status === 'refunded' ? 'refunded' : 'due';
  const rows = await db.query(`select r.*, c.name, c.phone from refunds r left join customers c on c.id = r.customer_id where r.status = $1
    order by ${status === 'due' ? 'r.created_at' : 'r.refunded_at desc'} limit 200`, [status]);
  const total = (await db.one(`select count(*)::int n from refunds where status = $1`, [status])).n;
  return { refunds: rows, total };
});
route('POST', '/admin/refunds/:id', ops, async ({ db, staff, params, body }) =>
  ({ refund: await db.one(`select * from fn_mark_refunded($1, $2, $3)`, [staff.id, params.id, str(body.ref, 80)]) }));

route('GET', '/admin/audit', ops, async ({ db, query }) => {
  const entity = str(query.entity || '', 40), id = str(query.id || '', 80), action = str(query.action || '', 60), actor = str(query.actor || '', 80);
  const before = int(query.before);                               // paging: entries older than this id
  const rows = await db.query(`select id, at, actor, action, entity, entity_id, data from audit_log
    where ($1 = '' or entity = $1) and ($2 = '' or entity_id = $2) and ($3 = '' or action like $3 || '%') and ($4 = '' or actor = $4) and ($5::bigint is null or id < $5)
    order by id desc limit 201`, [entity, id, action, actor, Number.isSafeInteger(before) ? before : null]);
  return { entries: rows.slice(0, 200), more: rows.length > 200 };
});

route('GET', '/admin/staff', adminOnly, async ({ db }) => ({ staff: await db.query(`select id, email, name, role, dealer_id, active, must_change_password, created_at from staff order by created_at`) }));
route('POST', '/admin/staff', adminOnly, async ({ db, staff, body }) => {
  const email = str(body.email, 200).toLowerCase(); const name = str(body.name, 120);
  const role = ['admin', 'ops', 'dealer'].includes(body.role) ? body.role : fail(400, 'BAD_ROLE', 'Choose a role.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) fail(400, 'BAD_STAFF', 'Enter a name and a valid email.');
  if (role === 'dealer' && !body.dealer_id) fail(400, 'BAD_STAFF', 'Choose the dealer this person works for.');
  if (await db.one(`select 1 from staff where email = $1`, [email])) fail(409, 'STAFF_EXISTS', 'A staff account with that email already exists.');
  if (role === 'dealer' && !(await db.one(`select 1 from dealers where id = $1`, [str(body.dealer_id, 40)]))) fail(400, 'BAD_STAFF', 'That dealer doesn’t exist.');
  const password = sec.newPassword(), secret = sec.newTotpSecret();
  const s = await db.one(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret, must_change_password) values ($1, $2, $3, $4, $5, $6, true) returning id`,
    [email, name, role, role === 'dealer' ? str(body.dealer_id, 40) : null, sec.hashPassword(password), secret]);
  await audit(db, 'staff:' + staff.id, 'staff.created', 'staff', s.id, { email, role });
  return { staff: { id: s.id, email, role }, setup: { password, totpSecret: secret, otpauthUrl: sec.otpauthUrl(secret, email), note: 'Shown once. Share it securely. They must choose a new password when they first sign in.' } };
});
// Lost password or phone: a new temporary password and a new authenticator secret; all their sessions end.
const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
route('POST', '/admin/staff/:id/reset', adminOnly, async ({ db, staff, params }) => {
  if (sameId(params.id, staff.id)) fail(400, 'SELF', 'Use “Change password” for your own account.');
  const password = sec.newPassword(), secret = sec.newTotpSecret();
  const s = await db.one(`update staff set password_hash = $2, totp_secret = $3, totp_last_step = 0, must_change_password = true where id = $1 returning id, email`, [params.id, sec.hashPassword(password), secret]);
  if (!s) fail(404, 'NOT_FOUND', 'Staff member not found.');
  await db.query(`update staff_sessions set revoked_at = now() where staff_id = $1 and revoked_at is null`, [params.id]);
  await audit(db, 'staff:' + staff.id, 'staff.reset', 'staff', params.id, {});
  return { setup: { password, totpSecret: secret, otpauthUrl: sec.otpauthUrl(secret, s.email), note: 'Shown once. Share it securely. They must choose a new password when they sign in.' } };
});
route('POST', '/admin/staff/:id/active', adminOnly, async ({ db, staff, params, body }) => {
  if (sameId(params.id, staff.id)) fail(400, 'SELF', 'You can’t deactivate your own account.');
  if (body.active !== true && (await db.one(`select count(*)::int n from staff where role = 'admin' and active and id <> $1`, [params.id])).n === 0)
    fail(400, 'LAST_ADMIN', 'At least one administrator must stay active.');
  if (!(await db.one(`update staff set active = $2 where id = $1 returning id`, [params.id, body.active === true]))) fail(404, 'NOT_FOUND', 'Staff member not found.');
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
    expired_micro: (await db.one(`select fn_expire_micro() n`)).n,
    purged_customers: (await db.one(`select fn_purge_closed() n`)).n,
    housekeeping: (await db.one(`select fn_housekeeping() r`)).r,
  };
  await ensureRates(db, fetchRates).catch(() => {});
  r.pushed = await sendPendingPush(db);
  return r;
});
async function sendPendingPush(db) {
  const pending = await db.query(`select n.id, n.customer_id, n.title, n.body, n.link from notifications n where n.push and n.pushed_at is null and n.created_at > now() - interval '2 days' order by n.id limit 500`);
  if (!pending.length) return 0;
  let sent = 0;
  if (push.enabled) {
    const tokens = await db.query(`select token, customer_id from push_tokens where customer_id = any($1::uuid[])`, [[...new Set(pending.map(n => n.customer_id))]]);
    const jobs = pending.flatMap(n => tokens.filter(t => t.customer_id === n.customer_id).map(t => ({ n, token: t.token })));
    const gone = new Set();
    for (let i = 0; i < jobs.length; i += 10) {                     // 10 at a time
      const res = await Promise.all(jobs.slice(i, i + 10).map(j => push.send(j.token, j.n).catch(() => ({ ok: false }))));
      res.forEach((r, k) => { if (r.gone) gone.add(jobs[i + k].token); if (r.ok) sent++; });
    }
    if (gone.size) await db.query(`delete from push_tokens where token = any($1::text[])`, [[...gone]]);
  }
  await db.query(`update notifications set pushed_at = now() where id = any($1::uuid[])`, [pending.map(n => n.id)]);
  return sent;
}

// The production deployment refuses to run with test providers (code 123456, sandbox payments or identity checks),
// unless ALLOW_SANDBOX=1 is set on purpose for a demo or staging project.
const sandboxBlocked = () => process.env.VERCEL_ENV === 'production' && process.env.ALLOW_SANDBOX !== '1'
  && (payments.sandbox || kyc.sandbox || otp.mode === 'test');

// Public routes are cheap to call, so each server instance limits them per address (in memory, no database write)
const publicHits = new Map();
function publicLimit(req) {
  const ip = clientIp(req), now = Date.now(), w = publicHits.get(ip) || { start: now, n: 0 };
  if (now - w.start > 60000) { w.start = now; w.n = 0; }
  w.n++; publicHits.set(ip, w);
  if (publicHits.size > 10000) for (const [k, v] of publicHits) if (now - v.start > 60000) publicHits.delete(k);
  if (w.n > 240) fail(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute.', { retryIn: Math.ceil((60000 - (now - w.start)) / 1000) });
}

// ---------- entry point ----------
export async function handle(req, res, opts = {}) {
  const db = opts.db || (await getDb());
  const fetchRates = opts.fetchRates || fetchLiveRates;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');                            // answers differ by Origin, so caches must keep them apart
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  const send = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  const url = new URL(req.url, 'http://x');
  // On Vercel the rewrite in vercel.json passes the route as ?path=; locally it is the URL path. A second "path"
  // parameter means someone is trying to make one route look like another, so it is refused.
  const paths = url.searchParams.getAll('path');
  const path = (paths.length ? '/' + paths[0] : url.pathname.replace(/^\/api\/v1/, '')) || '/';
  const query = Object.fromEntries(url.searchParams);
  try {
    if (paths.length > 1) fail(400, 'BAD_PATH', 'Bad request.');
    let match = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(path);
      if (m) { match = r; r.keys.forEach((k, i) => { params[k] = decode(m[i + 1]) ?? fail(400, 'BAD_PATH', 'Bad request.'); }); break; }
    }
    if (!match) fail(404, 'NOT_FOUND', 'Not found.');
    if (!db && path !== '/config') fail(503, 'NOT_CONNECTED', 'PGBX services aren’t connected yet.');
    if (sandboxBlocked() && path !== '/config') fail(503, 'SANDBOX_IN_PRODUCTION', 'PGBX is being set up. Please try again later.');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    if (hasBody && !String(req.headers['content-type'] || '').includes('application/json'))
      fail(415, 'JSON_ONLY', 'Send JSON.');
    const { raw, json } = await readBody(req);
    const ctx = { req, res, db, raw, body: json && typeof json === 'object' ? json : {}, params, query, fetchRates };
    if (!match.opts.auth && !match.opts.staff && req.method === 'GET') publicLimit(req);
    if (match.opts.auth === 'customer') ctx.customer = await customerFrom(ctx);
    if (match.opts.staff) ctx.staff = await staffFrom(ctx, match.opts.staff);
    send(200, await match.handler(ctx));
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
    const code = String(e.message || '').match(/^[A-Z_]+$/) ? e.message : null;
    if (code && MESSAGES[code]) return send(MESSAGES[code][0], { error: code, message: MESSAGES[code][1] });
    if (e.expose) return send(e.status || 400, { error: 'PROVIDER', message: e.message });
    if (e.code === '22P02') return send(400, { error: 'BAD_ID', message: 'That ID isn’t valid.' });
    // Database constraint errors are the request's fault, not the server's: answer 409/400 instead of 500.
    if (e.code === '23505') return send(409, { error: 'ALREADY_EXISTS', message: 'That already exists. Use a different value.' });
    if (e.code === '23503') return send(400, { error: 'BAD_REFERENCE', message: 'Something this refers to doesn’t exist. Check the IDs and try again.' });
    if (['22003', '22007', '22008', '22001', '23514', '23502'].includes(e.code)) return send(400, { error: 'BAD_VALUE', message: 'One of the values isn’t valid. Check it and try again.' });
    if (e.code === 'P0001' && code) { console.error('PGBX API unmapped code', code); return send(400, { error: code, message: 'That request couldn’t be completed. Check it and try again.' }); }
    console.error('PGBX API error', req.method, path, e.code || '', String(e.message || e).slice(0, 300));
    send(500, { error: 'SERVER', message: 'Something went wrong on our side. Please try again.' });
  }
}
