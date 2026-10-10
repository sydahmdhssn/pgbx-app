// Second October audit fixes (see the tests below).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp } from '../server/security.mjs';

Object.assign(process.env, { OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'whsec-test', CRON_SECRET: 'cron-test' });
const { handle } = await import('../server/api.mjs');

let db, server, base;
const rates = () => { const at = new Date().toISOString(); return { ok: true, metals: { gold: { buyTola: 466560, sellTola: 460000, source: 'test', sourceUpdatedAt: at }, silver: { buyTola: 6400, sellTola: 6240, sourceUpdatedAt: at } }, usdPkr: { rate: 280 } }; };

async function call(method, path, { body, token, ip = '10.10.0.1' } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), 'x-real-ip': ip },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.error, code); return r.data; };
let n = 0;
const phone = () => '30099' + String(10000 + ++n).slice(-5);
async function login(ph) {
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone: ph }, ip: '10.10.1.' + n }));
  return ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: ph, code: '123456', cookie: false }, ip: '10.10.1.' + n })).token;
}
async function verified() {
  const ph = phone(); const token = await login(ph);
  const k = ok(await call('POST', '/api/v1/kyc', { token, body: {} }));
  ok(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token, body: { cnic: '42201' + ph.slice(-7) + '1', name: 'Hina Raza', dob: '1990-01-01', expiry: '2032-01-01' } }));
  return token;
}
async function staffToken(role) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@pgbx.test`, password = 'pw-' + role + '-long-enough', secret = newTotpSecret();
  await db.query(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret) values ($1, $2, $3, $4, $5, $6)`,
    [email, 'Ayesha ' + role, role, role === 'dealer' ? (await db.one(`select id from dealers limit 1`)).id : null, hashPassword(password), secret]);
  const t = ok(await call('POST', '/api/v1/staff/login', { body: { email, password, cookie: false } })).token;
  ok(await call('POST', '/api/v1/staff/mfa', { token: t, body: { code: totp(secret) } }));
  return t;
}
const key = () => 'k-' + Math.random().toString(36).slice(2, 12);
const IBAN = 'PK36SCBL0000001123456702';
let sup, adm;

before(async () => {
  db = await createMemoryDb();
  server = http.createServer((req, res) => handle(req, res, { db, fetchRates: async () => rates() }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ok(await call('GET', '/api/v1/rates'));                         // records today's market price
  sup = await staffToken('support'); adm = await staffToken('admin');
});
after(async () => { server.close(); await db.close(); });

const open = (token, kind, details, indicativePkr) => call('POST', '/api/v1/chats', { token, body: { kind, details, indicativePkr } });
const confirm = (token, id, prices, minutes) => call('POST', `/api/v1/support/chats/${id}/confirm`, { token, body: { prices, minutes, note: 'Agreed by phone' } });

const give = (t, product, units) => db.one(`select id from customers c join sessions s on s.customer_id = c.id where s.token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')`, [t])
  .then(c => db.query(`insert into ledger (customer_id, product_id, delta, reason, ref, created_by) values ($1, $2, $3, 'purchase', 'test', 'test')`, [c.id, product, units]).then(() => c.id));

// Fixes from the second October audit: collections need the customer's code, identity changes can't be used to take
// an account's metal, rates can't be confirmed far below market, sign-in limits can't be raced or used to lock
// someone out, request keys can't be reused for a different request, and terms acceptance is recorded.
const cidOf = t => db.one(`select customer_id id from sessions where token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')`, [t]).then(r => r.id);

test('a dealer hands bars over only against the customer’s code, and only to a verified customer', async () => {
  const t = await verified(); await give(t, 'g-1g', 2);
  const r = ok(await call('POST', '/api/v1/redemptions', { token: t, body: { productId: 'g-1g', units: 1, dealerId: 'd1' } })).redemption;
  const dealer = await staffToken('dealer');
  ok(await call('POST', `/api/v1/dealer/redemptions/${r.id}/ready`, { token: dealer, body: {} }));
  err(await call('POST', `/api/v1/dealer/redemptions/${r.id}/handover`, { token: dealer, body: { serials: ['S1'], cnicChecked: true } }), 404, 'CODE_NOT_FOUND');
  err(await call('POST', `/api/v1/dealer/redemptions/${r.id}/handover`, { token: dealer, body: { serials: ['S1'], cnicChecked: true, code: '000000' } }), 404, 'CODE_NOT_FOUND');
  ok(await call('POST', `/api/v1/dealer/redemptions/${r.id}/handover`, { token: dealer, body: { serials: ['S1'], cnicChecked: true, code: r.code } }));
});

test('changing a verified identity cancels collections, tells the customer and pauses selling and collecting', async () => {
  const t = await verified(); await give(t, 'g-1g', 2);
  const r = ok(await call('POST', '/api/v1/redemptions', { token: t, body: { productId: 'g-1g', units: 1, dealerId: 'd1' } })).redemption;
  assert.equal(ok(await call('PATCH', '/api/v1/me', { token: t, body: { name: 'Someone Else', cnic: '3520212345671' } })).reverify, true);
  assert.equal((await db.one(`select status from redemptions where id = $1`, [r.id])).status, 'cancelled');
  const dealer = await staffToken('dealer');
  err(await call('POST', '/api/v1/dealer/lookup', { token: dealer, body: { code: r.code } }), 404, 'CODE_NOT_FOUND');
  assert.ok((await db.query(`select 1 from notifications where customer_id = $1 and kind = 'security' and title like 'Your identity%'`, [await cidOf(t)])).length);
  err(await call('POST', '/api/v1/redemptions', { token: t, body: { productId: 'g-1g', units: 1, dealerId: 'd1' } }), 403);
});

test('support can’t confirm a buy far below market', async () => {
  const t = await verified();
  const c = ok(await open(t, 'buy_bars', { lines: [{ product_id: 'g-1g', units: 1 }] })).chat;
  const mkt = ok(await call('GET', `/api/v1/support/chats/${c.id}`, { token: sup })).suggested.prices.unit['g-1g'];
  err(await confirm(sup, c.id, { unit: { 'g-1g': Math.round(mkt * 0.9) } }), 400, 'RATE_OUT_OF_RANGE');
  ok(await confirm(sup, c.id, { unit: { 'g-1g': Math.round(mkt * 0.99) } }));
});

test('parallel requests can’t overrun per-customer limits (open chats)', async () => {
  const t = await verified(); await give(t, 'g-1g', 1);
  const res = await Promise.all(['g-10mg', 'g-20mg', 'g-50mg', 'g-100mg', 'g-500mg', 'g-1g', 'g-5g'].map(p => open(t, 'buy_bars', { lines: [{ product_id: p, units: 1 }] })));
  assert.ok(res.filter(r => r.status === 200).length <= 5);
});

test('the store-review code has its own small allowance; staff can sign in from a known address during an attack', async () => {
  const rv = '3009998801'; process.env.REVIEW_LOGIN = rv + ':482915:2099-12-31';
  try {
    const res = await Promise.all(Array.from({ length: 45 }, (_, i) => call('POST', '/api/v1/auth/otp/verify', { body: { phone: rv, code: String(100000 + i) }, ip: '192.0.2.' + (i + 1) })));
    assert.ok(res.filter(r => r.data && r.data.error === 'WRONG_CODE').length <= 30);
  } finally { delete process.env.REVIEW_LOGIN; }
  const email = `known-${Math.random().toString(36).slice(2, 8)}@pgbx.test`, password = 'pw-known-long-enough';
  await db.query(`insert into staff (email, name, role, password_hash, totp_secret) values ($1, 'K', 'ops', $2, $3)`, [email, hashPassword(password), newTotpSecret()]);
  ok(await call('POST', '/api/v1/staff/login', { body: { email, password, cookie: false }, ip: '198.51.100.7' }));
  await Promise.all(Array.from({ length: 45 }, (_, i) => call('POST', '/api/v1/staff/login', { body: { email, password: 'x' + i }, ip: '203.0.113.' + (i + 1) })));
  err(await call('POST', '/api/v1/staff/login', { body: { email, password, cookie: false }, ip: '203.0.113.200' }), 429);   // a new address waits
  ok(await call('POST', '/api/v1/staff/login', { body: { email, password, cookie: false }, ip: '198.51.100.7' }));         // the known one doesn't
});

test('a request key used again for a different request is refused; /sync is limited; terms acceptance is recorded', async () => {
  await db.query(`update settings set value = 'false' where key = 'rate_chat_required'`);
  try {
    const t = await verified(); const k = key();
    ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 1, idempotencyKey: k } }));
    ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 1, idempotencyKey: k } }));                  // the same request again
    err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 3, idempotencyKey: k } }), 409, 'KEY_REUSED');
  } finally { await db.query(`update settings set value = 'true' where key = 'rate_chat_required'`); }
  const t = await login(phone());
  const codes = [];
  for (let i = 0; i < 45 && !codes.includes(429); i++) codes.push((await call('GET', '/api/v1/sync', { token: t })).status);   // 45: a minute can roll over mid-loop
  assert.ok(codes.includes(429));
  const ph = phone();
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone: ph }, ip: '10.10.5.1' }));
  const v = ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: ph, code: '123456', cookie: false, terms: '1.0' }, ip: '10.10.5.1' }));
  const c = await db.one(`select terms_version, terms_accepted_at from customers where id = $1`, [v.customer.id]);
  assert.equal(c.terms_version, '1.0'); assert.ok(c.terms_accepted_at);
  ok(await call('POST', '/api/v1/me/terms', { token: v.token, body: { version: '1.1' } }));
  err(await call('POST', '/api/v1/me/terms', { token: v.token, body: { version: '<script>' } }), 400);
});

test('refunding a flagged order goes through the refunds queue; phone notifications are claimed once', async () => {
  const t = await verified(); const cid = await cidOf(t);
  const lk = await db.one(`insert into price_locks (customer_id, snapshot_id, prices, expires_at) values ($1, (select id from rate_snapshots order by id desc limit 1), '{}', now()) returning id`, [cid]);
  const o = await db.one(`insert into orders (customer_id, lock_id, receipt_no, status, total_pkr, method, idempotency_key) values ($1, $3, 'PGBX-R-TEST-' || substr(md5(random()::text), 1, 6), 'flagged', 5000, 'bank', $2) returning id`, [cid, key(), lk.id]);
  await db.query(`insert into payments (order_id, provider, provider_ref, amount_pkr, status) values ($1, 'sandbox', $2, 5000, 'succeeded')`, [o.id, 'sbx-' + key()]);
  ok(await call('POST', `/api/v1/admin/orders/${o.id}/resolve`, { token: adm, body: { action: 'refund', note: 'Late payment' } }));
  const due = await db.query(`select amount_pkr, status from refunds where kind = 'order' and entity_id = $1`, [o.id]);
  assert.deepEqual(due.map(r => [Number(r.amount_pkr), r.status]), [[5000, 'due']]);
  await db.query(`insert into notifications (customer_id, kind, title, body, push) values ($1, 'account', 'x', 'y', true)`, [cid]);
  const [a, b] = await Promise.all([db.query(`select * from fn_claim_push(500)`), db.query(`select * from fn_claim_push(500)`)]);
  assert.equal([...a, ...b].filter(n => n.customer_id === cid && n.title === 'x').length, 1);
});
