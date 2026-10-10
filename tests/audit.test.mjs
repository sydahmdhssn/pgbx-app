// Regression tests for the issues found in the October 2026 audit: each test pins one fix so it can't come back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp, sign } from '../server/security.mjs';

Object.assign(process.env, { OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'whsec-test', CRON_SECRET: 'cron-test' });
const { handle } = await import('../server/api.mjs');

let db, server, base;
let rates = () => { const at = new Date().toISOString(); return { ok: true, metals: { gold: { buyTola: 466560, sellTola: 460000, source: 'test', sourceUpdatedAt: at }, silver: { buyTola: 6400, sellTola: 6240, sourceUpdatedAt: at } } }; };

async function call(method, path, { body, token, ip = '10.1.0.1', headers = {}, raw } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), 'x-real-ip': ip, ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.error, code); assert.ok(r.data.message); return r.data; };
async function login(phone, ip) {
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone }, ip }));
  return ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone, code: '123456', cookie: false }, ip })).token;
}
const kycBody = (phone, extra = {}) => ({ cnic: '42201' + phone.slice(-7) + '3', name: 'Bilal Ahmed', dob: '1988-03-14', expiry: '2032-01-01', ...extra });
async function verified(phone, ip) {
  const token = await login(phone, ip);
  const k = ok(await call('POST', '/api/v1/kyc', { token, body: {} }));
  assert.equal(ok(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token, body: kycBody(phone) })).status, 'verified');
  return token;
}
async function staffAccount(role, { mustChange = false, dealer = null } = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@pgbx.test`, password = 'pw-' + role + '-long-enough', secret = newTotpSecret();
  await db.query(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret, must_change_password) values ($1, $2, $3, $4, $5, $6, $7)`,
    [email, 'Staff ' + role, role, dealer, hashPassword(password), secret, mustChange]);
  return { email, password, secret };
}
async function staffToken(s, ip) { return ok(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: s.password, cookie: false }, ip })).token; }

before(async () => {
  db = await createMemoryDb(); await db.query(`update settings set value = 'false' where key = 'rate_chat_required'`);
  server = http.createServer((req, res) => handle(req, res, { db, fetchRates: async () => rates() }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

test('P0: identity details can’t change while a check is under review; changing them after verification needs a new check', async () => {
  const t = await login('3002220001', '10.1.1.1');
  const k = ok(await call('POST', '/api/v1/kyc', { token: t, body: {} }));
  assert.equal(ok(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token: t, body: kycBody('3002220001', { name: 'Please Review Me' }) })).status, 'review');
  err(await call('PATCH', '/api/v1/me', { token: t, body: { name: 'Someone Else' } }), 409, 'KYC_IN_PROGRESS');
  err(await call('PATCH', '/api/v1/me', { token: t, body: { cnic: '4220199999993' } }), 409, 'KYC_IN_PROGRESS');
  ok(await call('PATCH', '/api/v1/me', { token: t, body: { email: 'ok@example.com' } }));       // other fields still fine
  err(await call('POST', '/api/v1/kyc', { token: t, body: {} }), 409, 'KYC_IN_PROGRESS');
  assert.equal(ok(await call('GET', '/api/v1/me', { token: t })).profile.name, 'Please Review Me');

  const v = await verified('3002220002', '10.1.1.2');
  err(await call('POST', '/api/v1/kyc', { token: v, body: {} }), 409, 'KYC_DONE');
  assert.equal(ok(await call('PATCH', '/api/v1/me', { token: v, body: { name: 'Bilal Ahmed Khan' } })).reverify, true);
  assert.equal(ok(await call('GET', '/api/v1/me', { token: v })).kyc.status, 'reverify');
  const l = ok(await call('POST', '/api/v1/locks', { token: v, body: { products: ['g-1g'] } }));
  err(await call('POST', '/api/v1/orders', { token: v, body: { lockId: l.lock.id, lines: [{ productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: 'audit-key-1' } }), 403, 'KYC_REQUIRED');
});

test('identity check: real dates, 18 or older, unexpired CNIC, one CNIC per account', async () => {
  const t = await login('3002220003', '10.1.2.1');
  const k = ok(await call('POST', '/api/v1/kyc', { token: t, body: {} }));
  const submit = b => call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token: t, body: kycBody('3002220003', b) });
  err(await submit({ dob: '1990-02-30' }), 400, 'BAD_KYC');
  err(await submit({ dob: 'yesterday' }), 400, 'BAD_KYC');
  err(await submit({ dob: new Date(Date.now() - 16 * 365 * 864e5).toISOString().slice(0, 10) }), 400, 'UNDER_18');
  err(await submit({ expiry: '2020-01-01' }), 400, 'CNIC_EXPIRED');
  err(await call('PATCH', '/api/v1/me', { token: t, body: { dob: '2015-01-01' } }), 400, 'BAD_DOB');
  // Same CNIC as an already verified account: a person checks it instead of an automatic pass
  await verified('3002220004', '10.1.2.2');
  assert.equal(ok(await submit({ cnic: kycBody('3002220004').cnic })).status, 'review');
});

test('changing the mobile number: validated, rate limited before lookup, other sessions signed out', async () => {
  const t = await login('3002220005', '10.1.3.1');
  const other = ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3002220005', code: '123456', cookie: false }, ip: '10.1.3.2' })).token;   // a second device
  await login('3002220006', '10.1.3.3');
  err(await call('POST', '/api/v1/me/phone/start', { token: t, body: { phone: '3002220006' } }), 409, 'PHONE_IN_USE');
  err(await call('POST', '/api/v1/me/phone/verify', { token: t, body: { phone: 'abc', code: '123456' } }), 400, 'BAD_CODE');
  err(await call('POST', '/api/v1/me/phone/verify', { token: t, body: { phone: '3002220006', code: '123456' } }), 409, 'PHONE_IN_USE');
  ok(await call('POST', '/api/v1/me/phone/start', { token: t, body: { phone: '3002220007' } }));
  ok(await call('POST', '/api/v1/me/phone/verify', { token: t, body: { phone: '3002220007', code: '123456' } }));
  assert.equal(ok(await call('GET', '/api/v1/me', { token: t })).profile.phone, '3002220007');
  err(await call('GET', '/api/v1/me', { token: other }), 401, 'SESSION_EXPIRED');
  // after 3 attempts in an hour the limit applies even to a number in use (no free lookups)
  err(await call('POST', '/api/v1/me/phone/start', { token: t, body: { phone: '3002220006' } }), 409, 'PHONE_IN_USE');
  err(await call('POST', '/api/v1/me/phone/start', { token: t, body: { phone: '3002220006' } }), 429, 'RATE_LIMITED');
});

test('payment webhook ignores non-final statuses; a provider that can’t start a payment closes the order', async () => {
  const t = await verified('3002220008', '10.1.4.1');
  const l = ok(await call('POST', '/api/v1/locks', { token: t, body: { products: ['g-1g'] } }));
  const o = ok(await call('POST', '/api/v1/orders', { token: t, body: { lockId: l.lock.id, lines: [{ productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: 'audit-key-2' } })).order;
  const raw = JSON.stringify({ order_id: o.id, provider_ref: 'ref-p1', amount_pkr: o.total_pkr, status: 'pending' });
  assert.equal(ok(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-signature': sign(raw, 'whsec-test') } })).status, 'ignored');
  assert.equal((await db.one(`select status from orders where id = $1`, [o.id])).status, 'pending_payment');
  // a signature with multi-byte characters is refused, not a server error
  err(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-signature': 'é'.repeat(64) } }), 401, 'BAD_SIGNATURE');

  process.env.PAYMENT_PROVIDER = 'notyet';
  try {
    const l2 = ok(await call('POST', '/api/v1/locks', { token: t, body: { products: ['g-1g'] } }));
    err(await call('POST', '/api/v1/orders', { token: t, body: { lockId: l2.lock.id, lines: [{ productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: 'audit-key-3' } }), 503, 'PROVIDER');
    assert.equal((await db.one(`select status from orders where idempotency_key = 'audit-key-3'`)).status, 'failed');
  } finally { process.env.PAYMENT_PROVIDER = 'sandbox'; }
});

test('settings are checked before saving; blank premium is rejected', async () => {
  const s = await staffAccount('admin');
  const t = await staffToken(s, '10.1.5.1');
  ok(await call('POST', '/api/v1/staff/mfa', { token: t, body: { code: totp(s.secret) } }));
  for (const bad of [{ daily_limit_pkr: -5 }, { daily_limit_pkr: '1000000' }, { spread: { gold: 5, silver: 0.02 } }, { appraisal_slots: ['25:00-26:00'] },
    { gift_cities: [] }, { purity: { gold: { '22K': 9 }, silver: { '925': 0.925 } } }, { max_units_per_order: 5, price_lock_seconds: 1 }])
    err(await call('PATCH', '/api/v1/admin/settings', { token: t, body: bad }), 400, 'BAD_SETTING');
  assert.equal((await db.one(`select value from settings where key = 'max_units_per_order'`)).value, 10);   // nothing half-saved
  ok(await call('PATCH', '/api/v1/admin/settings', { token: t, body: { appraisal_slots: ['09:00-11:00', '11:00-13:00'], spread: { gold: 0.015, silver: 0.03 } } }));
  ok(await call('PATCH', '/api/v1/admin/settings', { token: t, body: { appraisal_slots: ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00'], spread: { gold: 0.012, silver: 0.025 } } }));
  err(await call('PATCH', '/api/v1/admin/products/g-1g', { token: t, body: { premium_pkr: '' } }), 400, 'BAD_PREMIUM');
  err(await call('POST', '/api/v1/admin/dealers', { token: t, body: { id: 'd1', name: 'Dup', area: 'X' } }), 409, 'DEALER_EXISTS');
  err(await call('POST', '/api/v1/admin/vault', { token: t, body: { product_id: 'nope', units: 1 } }), 400, 'UNKNOWN_PRODUCT');
  err(await call('POST', '/api/v1/admin/staff', { token: t, body: { email: s.email, name: 'Dup', role: 'ops' } }), 409, 'STAFF_EXISTS');
  err(await call('POST', '/api/v1/admin/staff', { token: t, body: { email: 'x@pgbx.test', name: 'X', role: 'dealer', dealer_id: 'nope' } }), 400, 'BAD_STAFF');
});

test('staff: authenticator code works once; new accounts must change the password; admin reset', async () => {
  const s = await staffAccount('ops');
  const t1 = await staffToken(s, '10.1.6.1');
  const code = totp(s.secret);
  ok(await call('POST', '/api/v1/staff/mfa', { token: t1, body: { code } }));
  const t2 = await staffToken(s, '10.1.6.2');
  err(await call('POST', '/api/v1/staff/mfa', { token: t2, body: { code } }), 401, 'BAD_CODE');      // replay of the same code
  // the panels use the cookie, so a normal sign-in doesn't return the token
  assert.equal(ok(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: s.password }, ip: '10.1.6.3' })).token, undefined);

  const n = await staffAccount('ops', { mustChange: true });
  const t = await staffToken(n, '10.1.6.4');
  ok(await call('POST', '/api/v1/staff/mfa', { token: t, body: { code: totp(n.secret) } }));
  err(await call('GET', '/api/v1/admin/overview', { token: t }), 403, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(ok(await call('GET', '/api/v1/staff/me', { token: t })).staff.mustChangePassword, true);
  err(await call('POST', '/api/v1/staff/password', { token: t, body: { current: 'wrong', next: 'a-much-longer-password' } }), 400, 'BAD_PASSWORD');
  err(await call('POST', '/api/v1/staff/password', { token: t, body: { current: n.password, next: 'short' } }), 400, 'WEAK_PASSWORD');
  ok(await call('POST', '/api/v1/staff/password', { token: t, body: { current: n.password, next: 'a-much-longer-password' } }));
  ok(await call('GET', '/api/v1/admin/overview', { token: t }));

  const a = await staffAccount('admin');
  const at = await staffToken(a, '10.1.6.5');
  ok(await call('POST', '/api/v1/staff/mfa', { token: at, body: { code: totp(a.secret) } }));
  const id = (await db.one(`select id from staff where email = $1`, [n.email])).id;
  const r = ok(await call('POST', `/api/v1/admin/staff/${id}/reset`, { token: at, body: {} }));
  assert.ok(r.setup.password && r.setup.totpSecret);
  err(await call('GET', '/api/v1/admin/overview', { token: t }), 401, 'SESSION_EXPIRED');             // their sessions ended
  err(await call('POST', '/api/v1/staff/login', { body: { email: n.email, password: 'a-much-longer-password' }, ip: '10.1.6.6' }), 401, 'BAD_LOGIN');
});

test('bad input is a 4xx, never a server error', async () => {
  const t = await login('3002220009', '10.1.7.1');
  err(await call('GET', '/api/v1/me', { headers: { cookie: 'pgbx_s=%E0%A4%A' } }), 401);              // malformed cookie
  err(await call('GET', '/api/v1/orders/%E0%A4%A', { token: t }), 400, 'BAD_PATH');                  // malformed percent-encoding
  err(await call('GET', '/api/v1/orders/not-a-uuid', { token: t }), 400, 'BAD_ID');
  err(await call('GET', '/api/v1/config?path=config&path=admin/overview'), 400, 'BAD_PATH');
  const v = await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3002220009', code: '123456' }, ip: '10.1.7.1' });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  err(await call('PATCH', '/api/v1/me', { headers: { cookie, origin: 'null' }, body: { email: 'a@b.co' } }), 403, 'BAD_ORIGIN');
  err(await call('PATCH', '/api/v1/me', { headers: { cookie, origin: 'https://pgbx-app-evil.vercel.app' }, body: { email: 'a@b.co' } }), 403, 'BAD_ORIGIN');
  err(await call('POST', '/api/v1/auth/otp/start', { raw: '{"phone":"' + 'é'.repeat(40000) + '"}' }), 413, 'TOO_LARGE');
  assert.equal((await call('GET', '/api/v1/config')).headers.get('vary'), 'Origin');
});

test('rates: a price without a source time or with an implausible jump is never recorded', async () => {
  ok(await call('GET', '/api/v1/rates'));
  const before = (await db.one(`select id from rate_snapshots order by id desc limit 1`)).id;
  const keep = rates;
  try {
    rates = () => ({ ok: true, metals: { gold: { buyTola: 466000, sellTola: 460000 }, silver: { buyTola: 6400, sellTola: 6240 } } });
    err(await call('GET', '/api/v1/rates'), 502, 'RATES_STALE_SOURCE');
    rates = () => { const r = keep(); r.metals.gold.buyTola = 700000; r.metals.gold.sellTola = 690000; return r; };
    err(await call('GET', '/api/v1/rates'), 502, 'RATES_CHECK');
    rates = () => { const r = keep(); r.metals.gold.sellTola = r.metals.gold.buyTola + 1; return r; };   // sell above buy
    err(await call('GET', '/api/v1/rates'), 502, 'RATES_DOWN');
  } finally { rates = keep; }
  assert.equal((await db.one(`select id from rate_snapshots order by id desc limit 1`)).id, before);
});
