// October audit fixes (see the tests below).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp } from '../server/security.mjs';

Object.assign(process.env, { OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'whsec-test', CRON_SECRET: 'cron-test' });
const { handle } = await import('../server/api.mjs');

let db, server, base;
const rates = () => { const at = new Date().toISOString(); return { ok: true, metals: { gold: { buyTola: 466560, sellTola: 460000, source: 'test', sourceUpdatedAt: at }, silver: { buyTola: 6400, sellTola: 6240, sourceUpdatedAt: at } }, usdPkr: { rate: 280 } }; };

async function call(method, path, { body, token, ip = '10.8.0.1' } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), 'x-real-ip': ip },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.error, code); return r.data; };
let n = 0;
const phone = () => '30088' + String(10000 + ++n).slice(-5);
async function login(ph) {
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone: ph }, ip: '10.8.1.' + n }));
  return ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: ph, code: '123456', cookie: false }, ip: '10.8.1.' + n })).token;
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

// Fixes from the October audit: money and metal can't be double-spent, rates can't be confirmed far from market,
// PIN attempts can't be raced, personal data is purged, and chat files have limits.
const give = (t, product, units) => db.one(`select id from customers c join sessions s on s.customer_id = c.id where s.token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')`, [t])
  .then(c => db.query(`insert into ledger (customer_id, product_id, delta, reason, ref, created_by) values ($1, $2, $3, 'purchase', 'test', 'test')`, [c.id, product, units]).then(() => c.id));
async function sellConfirmed(t, units, price) {
  const c = ok(await open(t, 'sell_bars', { lines: [{ product_id: 'g-1g', units }] })).chat;
  return ok(await confirm(sup, c.id, { unit: { 'g-1g': price } })).confirmation;
}

test('holdings can never go below zero, and bars sold back can’t also be collected', async () => {
  const t = await verified();
  const cid = await give(t, 'g-1g', 2);
  await assert.rejects(db.query(`insert into ledger (customer_id, product_id, delta, reason, ref, created_by) values ($1, 'g-1g', -3, 'adjustment', 'x', 'test')`, [cid]), /INSUFFICIENT_HOLDINGS/);
  // a sale and a collection of the same two bars at the same moment: only one can happen
  const r = await sellConfirmed(t, 2, 39500);
  const [sale, red] = await Promise.all([
    call('POST', '/api/v1/bars/sell', { token: t, body: { confirmationId: r.id, iban: IBAN, idempotencyKey: key() } }),
    call('POST', '/api/v1/redemptions', { token: t, body: { productId: 'g-1g', units: 2, dealerId: 'd1' } })]);
  assert.equal([sale.status, red.status].filter(s => s === 200).length, 1, JSON.stringify([sale.data, red.data]));
  const held = (await db.one(`select holdings_of($1, 'g-1g') - reserved_of($1, 'g-1g') as n`, [cid])).n;
  assert.equal(Number(held), 0);
});

test('rates are checked against the latest market price even when it is old; PGBX can’t overpay on a sell-back; time is capped', async () => {
  const t = await verified(); await give(t, 'g-1g', 3);
  const buy = ok(await open(t, 'buy_bars', { lines: [{ product_id: 'g-1g', units: 1 }] })).chat;
  await db.query(`update rate_snapshots set fetched_at = fetched_at - interval '3 hours'`);
  try {
    err(await confirm(sup, buy.id, { unit: { 'g-1g': 3980000 } }), 400, 'RATE_OUT_OF_RANGE');
  } finally { await db.query(`update rate_snapshots set fetched_at = fetched_at + interval '3 hours'`); }
  // market sell price of 1 g is about Rs 39,438: 10% over is refused for a sell-back, 4% over is allowed
  const sell = ok(await open(t, 'sell_bars', { lines: [{ product_id: 'g-1g', units: 1 }] })).chat;
  err(await confirm(sup, sell.id, { unit: { 'g-1g': 43400 } }), 400, 'RATE_OUT_OF_RANGE');
  const c = ok(await confirm(sup, sell.id, { unit: { 'g-1g': 41000 } }, 240)).confirmation;
  assert.ok(c.expires_in <= 15 * 60, 'held for at most rate_confirm_minutes: ' + c.expires_in);
  // the "app price" in the chat is PGBX's own, not what the request said
  const fake = ok(await open(t, 'buy_bars', { lines: [{ product_id: 'g-10mg', units: 1 }] }, 5)).chat;
  assert.ok(fake.indicative_pkr > 100, 'indicative price from the server: ' + fake.indicative_pkr);
});

test('a wrong PIN never undoes a logout, and parallel guesses can’t beat the limit of 5', async () => {
  const t = await login(phone());
  ok(await call('POST', '/api/v1/auth/pin', { token: t, body: { pin: '4826' } }));
  ok(await call('POST', '/api/v1/auth/lock', { token: t, body: {} }));
  const tries = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/api/v1/auth/unlock', { token: t, body: { pin: String(1000 + i * 7).padStart(4, '0') } })));
  const codes = tries.map(r => r.data && r.data.error);
  // at most 5 guesses are checked: 4 answered "wrong", the 5th ends the session; every other one is turned away unchecked
  assert.ok(codes.filter(c => c === 'WRONG_PIN').length <= 4, codes.join());
  assert.ok(codes.every(c => ['WRONG_PIN', 'PIN_LOCKED_OUT', 'PIN_WAIT'].includes(c)), codes.join());
  const sess = await db.one(`select pin_fails, revoked_at from sessions where token_hash = encode(sha256(convert_to($1, 'utf8')), 'hex')`, [t]);
  assert.ok(sess.pin_fails <= 5, 'checked guesses: ' + sess.pin_fails);
  // logout, then a wrong PIN: still logged out
  const t2 = await login(phone());
  ok(await call('POST', '/api/v1/auth/pin', { token: t2, body: { pin: '4826' } }));
  ok(await call('POST', '/api/v1/auth/logout', { token: t2, body: {} }));
  await call('POST', '/api/v1/auth/unlock', { token: t2, body: { pin: '0001' } });
  err(await call('GET', '/api/v1/me', { token: t2 }), 401);
});

test('purging a closed account removes bank accounts from paid bar sales and notes from confirmed rates', async () => {
  const t = await verified(); const cid = await give(t, 'g-1g', 1);
  const r = await sellConfirmed(t, 1, 39500);
  const sale = ok(await call('POST', '/api/v1/bars/sell', { token: t, body: { confirmationId: r.id, iban: IBAN, idempotencyKey: key() } })).sale;
  ok(await call('POST', `/api/v1/admin/bar-sales/${sale.id}`, { token: adm, body: { ref: 'IBFT-123456' } }));
  await db.query(`update settings set value = '0' where key = 'retention_days'`);
  try {
    assert.equal((await db.one(`select fn_close_account($1) r`, [cid])).r.closed, true);
    await db.query(`update customers set purge_after = now() - interval '1 second' where id = $1`, [cid]);
    await db.one(`select fn_purge_closed() n`);
    assert.equal((await db.one(`select payout_to from bar_sales where id = $1`, [sale.id])).payout_to, '[removed]');
    assert.equal((await db.one(`select note from rate_confirmations where id = $1`, [r.id])).note, null);
    await assert.rejects(db.query(`update bar_sales set total_pkr = 1 where id = $1`, [sale.id]), /APPEND_ONLY/);
  } finally { await db.query(`update settings set value = 'null' where key = 'retention_days'`); }
});

test('chat files have a limit per chat; staff reads are audited however they are asked for; uploads need a session first', async () => {
  const t = await verified();
  const c = ok(await open(t, 'buy_bars', { lines: [{ product_id: 'g-1g', units: 1 }] })).chat;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await db.query(`insert into chat_attachments (chat_id, uploaded_by, name, mime, size, data) select $1, 'test', 'x.png', 'image/png', 10, '\\x00' from generate_series(1, 30)`, [c.id]);
  err(await call('POST', `/api/v1/chats/${c.id}/attachments`, { token: t, body: { name: 'y.png', mime: 'image/png', data: png.toString('base64') } }), 429, 'TOO_MANY_FILES');
  // without a session, a large body is refused before it is read
  err(await call('POST', `/api/v1/chats/${c.id}/attachments`, { body: { data: 'A'.repeat(1000) } }), 401);
  const s2 = await staffToken('support');
  ok(await call('GET', `/api/v1/support/chats/${c.id}?after=1`, { token: s2 }));
  const seen = await db.query(`select 1 from audit_log where action = 'chat.viewed' and entity_id = $1 and actor like 'staff:%'`, [c.ref]);
  assert.equal(seen.length, 1);
  ok(await call('GET', `/api/v1/support/chats/${c.id}?after=1`, { token: s2 }));
  assert.equal((await db.query(`select 1 from audit_log where action = 'chat.viewed' and entity_id = $1`, [c.ref])).length, 1, 'once per shift, not every poll');
});

test('one /sync request returns every part the app shows, each the same as its own route', async () => {
  const t = await verified();
  const d = ok(await call('GET', '/api/v1/sync', { token: t }));
  assert.deepEqual(d.failed, []);
  for (const k of ['me', 'orders', 'ledger', 'redemptions', 'notifications', 'alerts', 'appraisals', 'gifts', 'micro', 'chats', 'barSales']) assert.ok(d.parts[k], k);
  assert.deepEqual(d.parts.orders, ok(await call('GET', '/api/v1/orders', { token: t })));
  err(await call('GET', '/api/v1/sync'), 401);
});
