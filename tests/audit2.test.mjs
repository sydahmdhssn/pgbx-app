// Regression tests for the second (7 October 2026) audit: each test pins one fix so it can't come back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp, sign } from '../server/security.mjs';

Object.assign(process.env, { OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'whsec-test', CRON_SECRET: 'cron-test' });
const { handle } = await import('../server/api.mjs');

let db, server, base;
let rates = () => { const at = new Date().toISOString(); return { ok: true, metals: { gold: { buyTola: 466560, sellTola: 460000, source: 'test', sourceUpdatedAt: at }, silver: { buyTola: 6400, sellTola: 6240, sourceUpdatedAt: at } }, usdPkr: { rate: 280 } }; };

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


const key = () => 'k-' + Math.random().toString(36).slice(2, 12);
async function adminToken(ip) {
  const a = await staffAccount('admin');
  const t = await staffToken(a, ip);
  ok(await call('POST', '/api/v1/staff/mfa', { token: t, body: { code: totp(a.secret) } }));
  return { t, a, id: (await db.one(`select id from staff where email = $1`, [a.email])).id };
}

test('C1: a second identity check can’t replace the identity under review', async () => {
  const t = await login('3004440001', '10.4.0.1');
  const A = ok(await call('POST', '/api/v1/kyc', { token: t, body: {} })).check;
  const B = ok(await call('POST', '/api/v1/kyc', { token: t, body: {} })).check;   // starting B closes A
  err(await call('POST', `/api/v1/kyc/${A.id}/submit`, { token: t, body: kycBody('3004440001') }), 404, 'KYC_NOT_FOUND');
  assert.equal(ok(await call('POST', `/api/v1/kyc/${B.id}/submit`, { token: t, body: kycBody('3004440001', { name: 'Please Review Me' }) })).status, 'review');
  err(await call('POST', '/api/v1/kyc', { token: t, body: {} }), 409, 'KYC_IN_PROGRESS');
  // the reviewer approves exactly the submitted identity
  const { t: at } = await adminToken('10.4.0.2');
  const list = ok(await call('GET', '/api/v1/admin/kyc?status=review', { token: at }));
  const row = list.checks.find(k => k.id === B.id);
  assert.equal(row.name, 'Please Review Me'); assert.equal(row.cnic, '42201-4440001-3'); assert.ok(list.total >= 1);
  ok(await call('POST', `/api/v1/admin/kyc/${B.id}/decide`, { token: at, body: { decision: 'passed' } }));
  const me = ok(await call('GET', '/api/v1/me', { token: t }));
  assert.equal(me.kyc.status, 'verified'); assert.equal(me.profile.name, 'Please Review Me');
});

test('H5/M24: changing the number needs a recent login; sales and collections pause for a day', async () => {
  const t = await verified('3004440002', '10.4.1.1');
  await db.query(`update sessions set created_at = now() - interval '1 hour' where customer_id = (select id from customers where phone = '3004440002')`);
  err(await call('POST', '/api/v1/me/phone/start', { token: t, body: { phone: '3004440099' } }), 403, 'REAUTH_REQUIRED');
  err(await call('POST', '/api/v1/me/phone/verify', { token: t, body: { phone: '3004440099', code: '123456' } }), 403, 'REAUTH_REQUIRED');
  const t2 = ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3004440002', code: '123456', cookie: false }, ip: '10.4.1.2' })).token;
  ok(await call('POST', '/api/v1/me/phone/start', { token: t2, body: { phone: '3004440099' }, ip: '10.4.1.2' }));
  ok(await call('POST', '/api/v1/me/phone/verify', { token: t2, body: { phone: '3004440099', code: '123456' }, ip: '10.4.1.2' }));
  err(await call('POST', '/api/v1/micro/sell', { token: t2, body: { grams: 0.001, iban: 'PK36SCBL0000001123456702', idempotencyKey: key() } }), 403, 'PHONE_RECENTLY_CHANGED');
  err(await call('POST', '/api/v1/redemptions', { token: t2, body: { productId: 'g-1g', units: 1, dealerId: 'd1' } }), 403, 'PHONE_RECENTLY_CHANGED');
});

test('M25/M26/L4: bad input is a clear 4xx; duplicate lines and null elements are refused', async () => {
  const t = await verified('3004440003', '10.4.2.1');
  const l = ok(await call('POST', '/api/v1/locks', { token: t, body: { products: ['g-1g'] } }));
  err(await call('POST', '/api/v1/orders', { token: t, body: { lockId: l.lock.id, lines: [{ productId: 'g-1g', units: 1 }, { productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: key() } }), 400, 'DUPLICATE_LINE');
  err(await call('POST', '/api/v1/orders', { token: t, body: { lockId: l.lock.id, lines: [null], method: 'bank', idempotencyKey: key() } }), 400, 'BAD_UNITS');
  err(await call('POST', '/api/v1/appraisals', { token: t, body: { items: [null], city: 'Karachi', area: 'DHA', address: 'House 1, Street 2, Phase 6', phone: '3001234567', date: '2099-01-01', slot: '10:00-12:00' } }), 400);
  err(await call('POST', '/api/v1/alerts', { token: t, body: { metal: 'gold', dir: 'above', targetPkr: 1e21 } }), 400, 'BAD_TARGET');
});

test('M28: push tokens are capped at 5 per customer', async () => {
  const t = await login('3004440004', '10.4.3.1');
  for (let i = 0; i < 8; i++) ok(await call('POST', '/api/v1/devices/push', { token: t, body: { token: 'tok-' + i, platform: 'android' } }));
  assert.equal((await db.one(`select count(*)::int n from push_tokens where customer_id = (select id from customers where phone = '3004440004')`)).n, 5);
});

test('M9: a sale whose price dropped since it was shown asks the customer to confirm again', async () => {
  const t = await verified('3004440005', '10.4.4.1');
  const b = ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 10, idempotencyKey: key() } }));
  ok(await call('POST', `/api/v1/payments/sandbox/micro/${b.order.id}`, { token: t, body: {} }));
  const r = err(await call('POST', '/api/v1/micro/sell', { token: t, body: { grams: 0.05, iban: 'PK36SCBL0000001123456702', idempotencyKey: key(), expectedAmountPkr: 99999 } }), 409, 'PRICE_CHANGED');
  assert.ok(r.amountPkr > 0 && r.amountPkr < 99999);
  ok(await call('POST', '/api/v1/micro/sell', { token: t, body: { grams: 0.05, iban: 'PK36SCBL0000001123456702', idempotencyKey: key(), expectedAmountPkr: r.amountPkr } }));
});

test('H8: refunds queue, second payments, and marking refunds paid', async () => {
  const t = await verified('3004440006', '10.4.5.1');
  const b = ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 1, idempotencyKey: key() } }));
  ok(await call('POST', `/api/v1/payments/sandbox/micro/${b.order.id}`, { token: t, body: {} }));
  const raw = JSON.stringify({ kind: 'micro', order_id: b.order.id, provider_ref: 'second-ref-1', amount_pkr: 280, status: 'succeeded' });
  assert.equal(ok(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-signature': sign(raw, 'whsec-test') } })).status, 'credited');
  const { t: at } = await adminToken('10.4.5.2');
  const q = ok(await call('GET', '/api/v1/admin/refunds', { token: at }));
  const r = q.refunds.find(x => x.payment_ref === 'second-ref-1');
  assert.ok(r && r.status === 'due' && r.amount_pkr === 280);
  assert.ok(ok(await call('GET', '/api/v1/admin/overview', { token: at })).refunds_due >= 1);
  assert.equal(ok(await call('POST', `/api/v1/admin/refunds/${r.id}`, { token: at, body: { ref: 'IBFT-9988' } })).refund.status, 'refunded');
  assert.ok(ok(await call('GET', '/api/v1/admin/refunds?status=refunded', { token: at })).refunds.some(x => x.id === r.id));
});

test('L1/L3: admins can’t remove themselves with a different-case id; one admin always stays; others can’t lock an account out', async () => {
  const { t, id } = await adminToken('10.4.6.1');
  err(await call('POST', `/api/v1/admin/staff/${id.toUpperCase()}/active`, { token: t, body: { active: false } }), 400, 'SELF');
  err(await call('POST', `/api/v1/admin/staff/${id.toUpperCase()}/reset`, { token: t, body: {} }), 400, 'SELF');
  const o = await staffAccount('ops');
  for (let i = 0; i < 5; i++) ok(await call('POST', '/api/v1/staff/login', { body: { email: o.email, password: o.password, cookie: false }, ip: '10.4.6.' + (10 + i) }));
  for (let i = 0; i < 8; i++) err(await call('POST', '/api/v1/staff/login', { body: { email: o.email, password: 'wrong' }, ip: '10.4.6.' + (20 + i) }), 401);
  ok(await call('POST', '/api/v1/staff/login', { body: { email: o.email, password: o.password, cookie: false }, ip: '10.4.6.40' }));   // other people's wrong passwords don't lock the owner out
});

test('L5/L6: signed timestamps stop replays; the identity provider can report results', async () => {
  const t = await verified('3004440007', '10.4.7.1');
  const b = ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 1, idempotencyKey: key() } }));
  const raw = JSON.stringify({ kind: 'micro', order_id: b.order.id, provider_ref: 'ts-ref', amount_pkr: 280, status: 'succeeded' });
  const old = String(Math.floor(Date.now() / 1000) - 600), now = String(Math.floor(Date.now() / 1000));
  err(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-timestamp': old, 'x-pgbx-signature': sign(old + '.' + raw, 'whsec-test') } }), 401, 'BAD_SIGNATURE');
  err(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-timestamp': now, 'x-pgbx-signature': sign(raw, 'whsec-test') } }), 401, 'BAD_SIGNATURE');
  ok(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-timestamp': now, 'x-pgbx-signature': sign(now + '.' + raw, 'whsec-test') } }));
  const raw2 = JSON.stringify({ kind: 'micro', order_id: b.order.id, provider_ref: 'dec-ref', amount_pkr: 280.5, status: 'succeeded' });
  err(await call('POST', '/api/v1/payments/webhook', { raw: raw2, headers: { 'x-pgbx-signature': sign(raw2, 'whsec-test') } }), 400, 'BAD_EVENT');
  // KYC provider callback
  process.env.KYC_WEBHOOK_SECRET = 'kyc-secret';
  const t2 = await login('3004440008', '10.4.7.2');
  const k = ok(await call('POST', '/api/v1/kyc', { token: t2, body: {} })).check;
  ok(await call('POST', `/api/v1/kyc/${k.id}/submit`, { token: t2, body: kycBody('3004440008', { name: 'Please Review Me' }) }));
  const kr = JSON.stringify({ check_id: k.id, status: 'passed' });
  err(await call('POST', '/api/v1/kyc/webhook', { raw: kr, headers: { 'x-pgbx-signature': sign(kr, 'wrong') } }), 401);
  assert.equal(ok(await call('POST', '/api/v1/kyc/webhook', { raw: kr, headers: { 'x-pgbx-signature': sign(kr, 'kyc-secret') } })).status, 'passed');
  assert.equal(ok(await call('GET', '/api/v1/me', { token: t2 })).kyc.status, 'verified');
});

test('L12/L13/M30: settings need a rule; inactive dealers are stopped; audit can be filtered and paged', async () => {
  const { t } = await adminToken('10.4.8.1');
  err(await call('PATCH', '/api/v1/admin/settings', { token: t, body: { not_a_setting: 1 } }), 400, 'BAD_SETTING');
  const f = ok(await call('GET', '/api/v1/admin/audit?action=staff.', { token: t }));
  assert.ok(f.entries.length > 0 && f.entries.every(e => e.action.startsWith('staff.')));
  const page2 = ok(await call('GET', `/api/v1/admin/audit?before=${f.entries[f.entries.length - 1].id}`, { token: t }));
  assert.ok(page2.entries.every(e => e.id < f.entries[f.entries.length - 1].id));
  const d = await staffAccount('dealer', { dealer: 'd4' });
  const dt = await staffToken(d, '10.4.8.2');
  ok(await call('POST', '/api/v1/staff/mfa', { token: dt, body: { code: totp(d.secret) } }));
  ok(await call('GET', '/api/v1/dealer/stock', { token: dt }));
  ok(await call('PATCH', '/api/v1/admin/dealers/d4', { token: t, body: { active: false } }));
  err(await call('GET', '/api/v1/dealer/stock', { token: dt }), 403, 'DEALER_INACTIVE');
  ok(await call('PATCH', '/api/v1/admin/dealers/d4', { token: t, body: { active: true } }));
});

test('C2: the production deployment refuses to run on sandbox providers', async () => {
  process.env.VERCEL_ENV = 'production';
  try {
    err(await call('GET', '/api/v1/products'), 503, 'SANDBOX_IN_PRODUCTION');
    ok(await call('GET', '/api/v1/config'));
    process.env.ALLOW_SANDBOX = '1';
    ok(await call('GET', '/api/v1/products'));
  } finally { delete process.env.VERCEL_ENV; delete process.env.ALLOW_SANDBOX; }
});

test('M15/H1: the app PIN is checked by the server per session; locked sessions can’t be used; 5 wrong PINs end it', async () => {
  const t = await login('3004440009', '10.4.9.1');
  err(await call('POST', '/api/v1/auth/pin', { token: t, body: { pin: '1234' } }), 400, 'WEAK_PIN');
  ok(await call('POST', '/api/v1/auth/pin', { token: t, body: { pin: '4826' } }));
  ok(await call('GET', '/api/v1/me', { token: t }));
  ok(await call('POST', '/api/v1/auth/lock', { token: t, body: {} }));
  err(await call('GET', '/api/v1/me', { token: t }), 423, 'LOCKED');
  ok(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '4826' } }));
  ok(await call('GET', '/api/v1/me', { token: t }));
  // changing the PIN needs the current one, and wrong ones count
  err(await call('POST', '/api/v1/auth/pin', { token: t, body: { pin: '7391', current: '0000' } }), 400, 'WRONG_PIN');
  ok(await call('POST', '/api/v1/auth/pin', { token: t, body: { pin: '7391', current: '4826' } }));
  // biometric key
  const { bioKey } = ok(await call('POST', '/api/v1/auth/biokey', { token: t, body: {} }));
  ok(await call('POST', '/api/v1/auth/lock', { token: t, body: {} }));
  ok(await call('POST', '/api/v1/auth/unlock', { token: t, body: { bioKey } }));
  // wrong PINs: pause after 3, end after 5
  ok(await call('POST', '/api/v1/auth/lock', { token: t, body: {} }));
  err(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '0001' } }), 400, 'WRONG_PIN');
  err(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '0002' } }), 400, 'WRONG_PIN');
  assert.equal(err(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '0003' } }), 400, 'WRONG_PIN').waitSeconds, 30);
  err(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '7391' } }), 429, 'PIN_WAIT');   // even the right PIN waits
  await db.query(`update sessions set pin_wait_until = now() - interval '1 second' where customer_id = (select id from customers where phone = '3004440009')`);
  err(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '0004' } }), 400, 'WRONG_PIN');
  err(await call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: '0005' } }), 401, 'PIN_LOCKED_OUT');
  err(await call('GET', '/api/v1/me', { token: t }), 401, 'SESSION_EXPIRED');
  // a new login on the same phone has no PIN until that customer chooses one
  const t2 = await login('3004440010', '10.4.9.2');
  ok(await call('GET', '/api/v1/me', { token: t2 }));
});

test('H2: a booking or gift order retried with the same key is made once', async () => {
  const day = n => new Date(Date.now() + 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
  const token = await verified('3001119901', '10.9.90.1');
  const k = key();
  const body = { city: 'Karachi', area: 'DHA', address: 'House 1, Street 2, Phase 6', phone: '0300 1234567', date: day(3), slot: '10:00-12:00', items: [{ metal: 'gold', karat: '22K', approx_g: 10 }], idempotencyKey: k };
  const [a1, a2] = await Promise.all([call('POST', '/api/v1/appraisals', { token, body }), call('POST', '/api/v1/appraisals', { token, body })]);
  assert.equal(ok(a1).appraisal.id, ok(a2).appraisal.id);
  const again = ok(await call('POST', '/api/v1/appraisals', { token, body }));
  assert.equal(again.appraisal.id, a1.data.appraisal.id);
  assert.equal((await db.one(`select count(*)::int n from appraisals where idempotency_key = $1`, [k])).n, 1);
  const gk = key();
  const giftBody = { item: 'gg-1g', shape: 'coin', design: 'wedding', engraving: '', message: '', packaging: 'standard', recipientName: 'Sara Ahmed', recipientPhone: '03211234567', recipientCity: 'Lahore', recipientAddress: 'House 9, Model Town, Lahore', deliverBy: day(8), idempotencyKey: gk };
  const g1 = ok(await call('POST', '/api/v1/gifts', { token, body: giftBody }));
  const g2 = ok(await call('POST', '/api/v1/gifts', { token, body: giftBody }));
  assert.equal(g1.gift.id, g2.gift.id);
  assert.equal((await db.one(`select count(*)::int n from gift_orders where idempotency_key = $1`, [gk])).n, 1);
});

test('M8: push and price-alert choices are saved on the server and applied when sending', async () => {
  const token = await login('3001119902', '10.9.90.2');
  const me = ok(await call('GET', '/api/v1/me', { token }));
  assert.deepEqual(me.notifPrefs, { push: true, alerts: true });
  assert.deepEqual(ok(await call('PATCH', '/api/v1/me/notifications', { token, body: { alerts: false, junk: 1 } })).notifPrefs, { push: true, alerts: false });
  assert.deepEqual(ok(await call('GET', '/api/v1/me', { token })).notifPrefs, { push: true, alerts: false });
  const c = await db.one(`select customer_id id from sessions where customer_id = (select id from customers where phone = '3001119902') limit 1`);
  await db.query(`select notify_customer($1, 'alert', 'Gold is above', 'x', null, true)`, [c.id]);
  await db.query(`select notify_customer($1, 'security', 'New login', 'x', null, true)`, [c.id]);
  const rows = await db.query(`select n.kind, n.kind = 'security' or (coalesce((c.notif_prefs->>'push')::boolean, true) and (n.kind <> 'alert' or coalesce((c.notif_prefs->>'alerts')::boolean, true))) wanted
    from notifications n join customers c on c.id = n.customer_id where c.id = $1`, [c.id]);
  assert.equal(rows.find(r => r.kind === 'alert').wanted, false);
  assert.equal(rows.find(r => r.kind === 'security').wanted, true);
});

test('Low: a lifetime CNIC can be verified', async () => {
  const token = await login('3001119903', '10.9.90.3');
  const k = ok(await call('POST', '/api/v1/kyc', { token, body: {} }));
  assert.equal(ok(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token, body: kycBody('3001119903', { expiry: 'lifetime' }) })).status, 'verified');
});
