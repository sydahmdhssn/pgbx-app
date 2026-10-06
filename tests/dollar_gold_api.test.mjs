// $1 gold over HTTP: quote, buying, the transaction IDs and their tola lots, selling, and the operations side.
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
  db = await createMemoryDb();
  server = http.createServer((req, res) => handle(req, res, { db, fetchRates: async () => rates() }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });


const day = () => 'k-' + Math.random().toString(36).slice(2);

test('$1 gold: quote, buy, pay, transaction IDs with their tola lot, and the wallet', async () => {
  const q = ok(await call('GET', '/api/v1/micro/quote')).quote;
  assert.equal(q.usd, 1); assert.equal(q.usdPkr, 280); assert.equal(q.unitPkr, 280);
  assert.equal(q.buyGram, 40000); assert.equal(q.gramsPerUnit, 0.007); assert.equal(q.unitsPerTola, 1667); assert.equal(q.fresh, true);
  const t = await verified('3003330001', '10.3.0.1');
  err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 0, idempotencyKey: day() } }), 400, 'BAD_UNITS');
  const b = ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 5, idempotencyKey: day() } }));
  assert.equal(b.order.total_pkr, 1400); assert.equal(b.payment.provider, 'sandbox');
  assert.equal(ok(await call('POST', `/api/v1/payments/sandbox/micro/${b.order.id}`, { token: t, body: {} })).status, 'credited');
  const m = ok(await call('GET', '/api/v1/micro', { token: t }));
  assert.equal(m.gold.grams, 0.035);
  const buys = m.transactions.filter(x => x.side === 'buy');
  assert.equal(buys.length, 5);
  buys.forEach(x => { assert.match(x.ref, /^PGBX-M-/); assert.equal(x.order_ref, b.order.ref); assert.equal(x.lots[0].ref.slice(0, 7), 'PGBX-T-'); });
  const one = ok(await call('GET', `/api/v1/micro/txns/${buys[0].ref}`, { token: t })).transaction;
  assert.equal(one.ref, buys[0].ref); assert.equal(one.lots.length, 1);
  assert.equal(ok(await call('GET', '/api/v1/me', { token: t })).wallet.gold_savings.grams, 0.035);
  // someone else's ID isn't visible
  const t2 = await verified('3003330002', '10.3.0.2');
  err(await call('GET', `/api/v1/micro/txns/${buys[0].ref}`, { token: t2 }), 404, 'NOT_FOUND');
});

test('$1 gold: provider webhook credits, sells pay out, operations settle lots and find any ID', async () => {
  const t = await verified('3003330003', '10.3.1.1');
  const b = ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 2, idempotencyKey: day() } }));
  const raw = JSON.stringify({ kind: 'micro', order_id: b.order.id, provider_ref: 'prov-m1', amount_pkr: 560, status: 'succeeded' });
  assert.equal(ok(await call('POST', '/api/v1/payments/webhook', { raw, headers: { 'x-pgbx-signature': sign(raw, 'whsec-test') } })).status, 'credited');
  err(await call('POST', '/api/v1/micro/sell', { token: t, body: { grams: 1, iban: 'PK36SCBL0000001123456702', idempotencyKey: day() } }), 409, 'INSUFFICIENT_GOLD');
  err(await call('POST', '/api/v1/micro/sell', { token: t, body: { grams: 0.005, iban: 'nope', idempotencyKey: day() } }), 400, 'BAD_IBAN');
  const s = ok(await call('POST', '/api/v1/micro/sell', { token: t, body: { grams: 0.0105, iban: 'pk36 scbl 0000 0011 2345 6702', idempotencyKey: day() } })).transaction;
  assert.match(s.ref, /^PGBX-MS-/); assert.equal(s.status, 'pending_payout'); assert.equal(s.payout_to, '•••• 6702'); assert.equal(s.lots[0].ref, 'PGBX-TS-000001');
  assert.equal(ok(await call('GET', '/api/v1/micro', { token: t })).gold.grams, 0.0035);

  const sa = await staffAccount('ops');
  const st = ok(await call('POST', '/api/v1/staff/login', { body: { email: sa.email, password: sa.password, cookie: false }, ip: '10.3.1.9' })).token;
  ok(await call('POST', '/api/v1/staff/mfa', { token: st, body: { code: totp(sa.secret) } }));
  const f = ok(await call('GET', `/api/v1/admin/micro/find?ref=${s.ref}`, { token: st }));
  assert.equal(f.transaction.customer.name, 'Bilal Ahmed'); assert.equal(f.transaction.payout_to, 'PK36SCBL0000001123456702');
  const fo = ok(await call('GET', `/api/v1/admin/micro/find?ref=${b.order.ref}`, { token: st }));
  assert.equal(fo.order.transactions.length, 2);
  const pay = ok(await call('GET', '/api/v1/admin/micro/payouts', { token: st })).payouts.find(p => p.ref === s.ref);
  err(await call('POST', `/api/v1/admin/micro/payouts/${pay.id}`, { token: st, body: { ref: '' } }), 400, 'BAD_REF');
  assert.equal(ok(await call('POST', `/api/v1/admin/micro/payouts/${pay.id}`, { token: st, body: { ref: 'IBFT-12345' } })).payout.status, 'paid_out');
  const lots = ok(await call('GET', '/api/v1/admin/micro/lots?side=buy', { token: st }));
  assert.ok(lots.lots.length >= 1); assert.equal(lots.totals.held > 0, true);
  const lot = ok(await call('GET', `/api/v1/admin/micro/lots/${lots.lots[0].ref}`, { token: st }));
  assert.ok(lot.transactions.length >= 7 && lot.transactions.every(x => /^PGBX-M-/.test(x.ref)));
  const ids = ok(await call('GET', `/api/v1/admin/micro/lots/${lots.lots[0].ref}/ids`, { token: st }));
  assert.equal(ids.ids.length, lot.lot.transactions); assert.match(ids.ids[0], /^PGBX-M-\S+\t0\.\d{6}$/);
  err(await call('POST', `/api/v1/admin/micro/lots/${lots.lots[0].id}/settle`, { token: st, body: { serial: 'X1' } }), 409, 'LOT_NOT_FULL');
  assert.ok('lots_to_settle' in ok(await call('GET', '/api/v1/admin/overview', { token: st })));
});

test('$1 gold: buying pauses without a dollar rate instead of guessing', async () => {
  const keep = rates;
  rates = () => { const r = keep(); delete r.usdPkr; return r; };
  try {
    await db.query(`update rate_snapshots set fetched_at = now() - interval '10 minutes'`);
    const t = await verified('3003330004', '10.3.2.1');
    err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 1, idempotencyKey: day() } }), 409, 'RATES_STALE');
    assert.equal(ok(await call('GET', '/api/v1/micro/quote')).quote.fresh, false);
  } finally { rates = keep; }
});
