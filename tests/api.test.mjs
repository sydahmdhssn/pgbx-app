// The API end to end: customer, dealer and admin journeys over HTTP against an in-memory database. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp, sign } from '../server/security.mjs';

Object.assign(process.env, { OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'whsec-test', CRON_SECRET: 'cron-test' });
const { handle } = await import('../server/api.mjs');

let db, server, base, ratesUp = true;
const fakeRates = async () => (ratesUp ? { ok: true, metals: { gold: { buyTola: 466560, sellTola: 460000, source: 'test' }, silver: { buyTola: 6400, sellTola: 6240 } } } : { ok: false });

// One IP per test user so per-device limits don't interfere between journeys
async function call(method, path, { body, token, ip = '10.0.0.1', headers = {}, raw } = {}) {
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
  return ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone, code: '123456', device: 'Test phone', cookie: false }, ip })).token;
}
async function verified(phone, ip) {
  const token = await login(phone, ip);
  const k = ok(await call('POST', '/api/v1/kyc', { token, body: {} }));
  assert.equal(ok(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token, body: { cnic: '4210112345671', name: 'Ayesha Khan', dob: '1990-05-01', expiry: '2031-01-01' } })).status, 'verified');
  return token;
}
async function buy(token, productId, units) {
  const l = ok(await call('POST', '/api/v1/locks', { token, body: { products: [productId] } }));
  const o = ok(await call('POST', '/api/v1/orders', { token, body: { lockId: l.lock.id, lines: [{ productId, units }], method: 'bank', idempotencyKey: 'key-' + Math.random() } }));
  return ok(await call('POST', `/api/v1/payments/sandbox/${o.order.id}`, { token, body: { outcome: 'success' } })).order;
}
async function staffAccount(role, dealer = null) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@pgbx.test`, password = 'pw-' + role + '-long', secret = newTotpSecret();
  await db.query(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret) values ($1, $2, $3, $4, $5, $6)`, [email, 'Staff ' + role, role, dealer, hashPassword(password), secret]);
  return { email, password, secret };
}
async function staffLogin(s, ip = '10.9.0.1') {
  const { token } = ok(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: s.password }, ip }));
  ok(await call('POST', '/api/v1/staff/mfa', { token, body: { code: totp(s.secret) }, ip }));
  return token;
}

before(async () => {
  db = await createMemoryDb();
  server = http.createServer((req, res) => handle(req, res, { db, fetchRates: fakeRates }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

test('config and public catalogue', async () => {
  const c = ok(await call('GET', '/api/v1/config'));
  assert.equal(c.live, true); assert.equal(c.otp.mode, 'test');
  assert.equal(ok(await call('GET', '/api/v1/dealers')).dealers.length, 4);
  assert.ok(ok(await call('GET', '/api/v1/products')).products.length >= 10);
  err(await call('GET', '/api/v1/nope'), 404, 'NOT_FOUND');
  err(await call('POST', '/api/v1/auth/otp/start', { raw: 'phone=1', headers: { 'Content-Type': 'text/plain' } }), 415, 'JSON_ONLY');
});

test('login: number checks, wrong code, sessions and logout', async () => {
  err(await call('POST', '/api/v1/auth/otp/start', { body: { phone: '12345' }, ip: '10.0.1.1' }), 400, 'BAD_PHONE');
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone: '0300 1110001' }, ip: '10.0.1.1' }));
  err(await call('POST', '/api/v1/auth/otp/start', { body: { phone: '3001110001' }, ip: '10.0.1.1' }), 429, 'RATE_LIMITED');   // 30 s between codes
  err(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3001110001', code: '000000' }, ip: '10.0.1.1' }), 400, 'WRONG_CODE');
  const v = ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3001110001', code: '123456' }, ip: '10.0.1.1' }));
  assert.equal(v.customer.isNew, true);
  const cookie = v.token && (await call('GET', '/api/v1/me', { token: v.token })).data;
  assert.equal(cookie.profile.phone, '3001110001');
  assert.equal(cookie.kyc.status, 'none');
  err(await call('GET', '/api/v1/me'), 401, 'SESSION_REQUIRED');
  err(await call('GET', '/api/v1/me', { token: 'not-a-token' }), 401, 'SESSION_EXPIRED');
  ok(await call('POST', '/api/v1/auth/logout', { token: v.token, body: {} }));
  err(await call('GET', '/api/v1/me', { token: v.token }), 401, 'SESSION_EXPIRED');
});

test('login cookie is HttpOnly and cookie writes need the app origin', async () => {
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone: '3001110002' }, ip: '10.0.2.1' }));
  const r = await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3001110002', code: '123456' }, ip: '10.0.2.1' });
  const set = r.headers.get('set-cookie');
  assert.match(set, /pgbx_s=/); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/);
  const cookie = set.split(';')[0];
  ok(await call('GET', '/api/v1/me', { headers: { cookie } }));
  err(await call('PATCH', '/api/v1/me', { headers: { cookie, origin: 'https://evil.example' }, body: { email: 'a@b.co' } }), 403, 'BAD_ORIGIN');
  ok(await call('PATCH', '/api/v1/me', { headers: { cookie, origin: 'https://pgbx-app.vercel.app' }, body: { email: 'a@b.co' } }));
});

test('identity check outcomes and the gate on buying', async () => {
  const token = await login('3001110003', '10.0.3.1');
  const l = ok(await call('POST', '/api/v1/locks', { token, body: { products: ['g-1g'] } }));
  err(await call('POST', '/api/v1/orders', { token, body: { lockId: l.lock.id, lines: [{ productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: 'abcdefgh1' } }), 403, 'KYC_REQUIRED');
  const k = ok(await call('POST', '/api/v1/kyc', { token, body: {} }));
  err(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token, body: { cnic: '123', name: 'A', dob: '1990-01-01', expiry: '2030-01-01' } }), 400, 'BAD_KYC');
  const r = ok(await call('POST', `/api/v1/kyc/${k.check.id}/submit`, { token, body: { cnic: '4210112345671', name: 'Please Review Me', dob: '1990-01-01', expiry: '2031-01-01' } }));
  assert.equal(r.status, 'review'); assert.ok(r.reason);
});

test('buying: lock, order, idempotency, sandbox payment, wallet and statement', async () => {
  const token = await verified('3001110004', '10.0.4.1');
  const l = ok(await call('POST', '/api/v1/locks', { token, body: { products: ['g-1g'] } }));
  assert.equal(l.lock.prices['g-1g'], 40000 + 1200);                       // 466,560 per tola = 40,000 per gram + premium
  const body = { lockId: l.lock.id, lines: [{ productId: 'g-1g', units: 2 }], method: 'bank', idempotencyKey: 'order-key-1' };
  const o1 = ok(await call('POST', '/api/v1/orders', { token, body }));
  const o2 = ok(await call('POST', '/api/v1/orders', { token, body }));
  assert.equal(o1.order.id, o2.order.id);
  assert.equal(o1.order.total_pkr, 82400);
  assert.equal(o1.payment.provider, 'sandbox');
  err(await call('POST', '/api/v1/orders', { token, body: { ...body, idempotencyKey: 'order-key-2', lines: [{ productId: 'g-1g', units: 11 }] } }), 400, 'ORDER_LIMIT');
  err(await call('POST', '/api/v1/orders', { token, body: { ...body, lines: [{ productId: 'g-1g', units: 1.5 }] } }), 400, 'BAD_UNITS');
  const paid = ok(await call('POST', `/api/v1/payments/sandbox/${o1.order.id}`, { token, body: { outcome: 'success' } }));
  assert.equal(paid.order.status, 'credited');
  ok(await call('POST', `/api/v1/payments/sandbox/${o1.order.id}`, { token, body: { outcome: 'success' } }));    // replay: no double credit
  const me = ok(await call('GET', '/api/v1/me', { token }));
  assert.deepEqual(me.wallet.holdings.map(h => [h.product_id, h.units]), [['g-1g', 2]]);
  assert.equal(me.wallet.holdings[0].value_pkr, Math.round(2 * 460000 / 11.664));
  const st = ok(await call('GET', '/api/v1/ledger', { token }));
  assert.equal(st.entries.length, 1); assert.equal(st.entries[0].delta, 2);
  const orders = ok(await call('GET', '/api/v1/orders', { token }));
  assert.equal(orders.orders[0].receipt_no, paid.order.receipt_no);
  err(await call('GET', '/api/v1/orders/not-a-uuid', { token }), 400, 'BAD_ID');
});

test('stale prices block buying instead of using an old rate', async () => {
  const token = await verified('3001110005', '10.0.5.1');
  await db.query(`update rate_snapshots set fetched_at = now() - interval '10 minutes'`);
  ratesUp = false;
  err(await call('POST', '/api/v1/locks', { token, body: { products: ['g-1g'] } }), 409, 'RATES_STALE');
  ratesUp = true;
  ok(await call('POST', '/api/v1/locks', { token, body: { products: ['g-1g'] } }));
});

test('payment webhook: signature required, wrong amount goes to operations', async () => {
  const token = await verified('3001110006', '10.0.6.1');
  const l = ok(await call('POST', '/api/v1/locks', { token, body: { products: ['s-1t'] } }));
  const { order } = ok(await call('POST', '/api/v1/orders', { token, body: { lockId: l.lock.id, lines: [{ productId: 's-1t', units: 1 }], method: 'card', idempotencyKey: 'webhook-key' } }));
  const event = JSON.stringify({ order_id: order.id, provider_ref: 'prov-1', amount_pkr: order.total_pkr - 100, status: 'succeeded' });
  err(await call('POST', '/api/v1/payments/webhook', { raw: event, headers: { 'x-pgbx-signature': 'sha256=deadbeef' } }), 401, 'BAD_SIGNATURE');
  const r = ok(await call('POST', '/api/v1/payments/webhook', { raw: event, headers: { 'x-pgbx-signature': 'sha256=' + sign(event, 'whsec-test') } }));
  assert.equal(r.status, 'flagged');
  assert.equal(ok(await call('GET', '/api/v1/me', { token })).wallet.holdings.length, 0, 'nothing credited until operations resolves it');
});

test('collection: reserve, dealer lookup, ready, handover with serials', async () => {
  const token = await verified('3001110007', '10.0.7.1');
  await buy(token, 'g-1g', 3);
  err(await call('POST', '/api/v1/redemptions', { token, body: { productId: 'g-1g', units: 4, dealerId: 'd1' } }), 409, 'INSUFFICIENT_HOLDINGS');
  err(await call('POST', '/api/v1/redemptions', { token, body: { productId: 'g-1g', units: 1, dealerId: 'd3' } }), 409, 'OUT_OF_STOCK');
  const { redemption } = ok(await call('POST', '/api/v1/redemptions', { token, body: { productId: 'g-1g', units: 2, dealerId: 'd1' } }));
  assert.match(redemption.code, /^\d{6}$/);
  const me = ok(await call('GET', '/api/v1/me', { token }));
  assert.equal(me.wallet.holdings[0].reserved, 2);

  const other = await staffLogin(await staffAccount('dealer', 'd2'), '10.9.7.2');
  err(await call('POST', '/api/v1/dealer/lookup', { token: other, body: { code: redemption.code } }), 404, 'CODE_NOT_FOUND');   // another dealer's code
  const dealer = await staffLogin(await staffAccount('dealer', 'd1'), '10.9.7.1');
  const found = ok(await call('POST', '/api/v1/dealer/lookup', { token: dealer, body: { code: redemption.code } })).redemption;
  assert.equal(found.units, 2);
  assert.doesNotMatch(JSON.stringify(found), /42101-1234567-1/, 'full CNIC never shown to the dealer');
  err(await call('POST', `/api/v1/dealer/redemptions/${found.id}/handover`, { token: dealer, body: { serials: ['A1', 'A2'], cnicChecked: true } }), 409, 'REDEMPTION_NOT_READY');
  ok(await call('POST', `/api/v1/dealer/redemptions/${found.id}/ready`, { token: dealer, body: {} }));
  err(await call('POST', `/api/v1/dealer/redemptions/${found.id}/handover`, { token: dealer, body: { serials: ['A1', 'A2'], cnicChecked: false } }), 400, 'CNIC_NOT_CHECKED');
  err(await call('POST', `/api/v1/dealer/redemptions/${found.id}/handover`, { token: dealer, body: { serials: ['A1', 'A1'], cnicChecked: true } }), 400, 'SERIALS_REQUIRED');
  const done = ok(await call('POST', `/api/v1/dealer/redemptions/${found.id}/handover`, { token: dealer, body: { serials: ['a1', 'a2'], cnicChecked: true } }));
  assert.equal(done.redemption.status, 'completed'); assert.deepEqual(done.redemption.serials, ['A1', 'A2']);
  assert.equal(ok(await call('GET', '/api/v1/me', { token })).wallet.holdings[0].units, 1);
  const stock = ok(await call('GET', '/api/v1/dealer/stock', { token: dealer })).stock.find(s => s.product_id === 'g-1g');
  assert.equal(stock.units, 4);
  const list = ok(await call('GET', '/api/v1/redemptions', { token })).redemptions;
  assert.equal(list[0].status, 'completed'); assert.equal(list[0].code, null, 'used codes are not shown again');
  err(await call('GET', '/api/v1/admin/overview', { token: dealer }), 403, 'FORBIDDEN');
});

test('customer can cancel a collection; alerts and notifications', async () => {
  const token = await verified('3001110008', '10.0.8.1');
  await buy(token, 's-1t', 1);
  const { redemption } = ok(await call('POST', '/api/v1/redemptions', { token, body: { productId: 's-1t', units: 1, dealerId: 'd1' } }));
  assert.equal(ok(await call('POST', `/api/v1/redemptions/${redemption.id}/cancel`, { token, body: {} })).redemption.status, 'cancelled');
  const a = ok(await call('POST', '/api/v1/alerts', { token, body: { metal: 'gold', dir: 'below', targetPkr: 999999 } })).alert;
  assert.equal(a.active, true);
  err(await call('POST', '/api/v1/alerts', { token, body: { metal: 'platinum', dir: 'below', targetPkr: 1 } }), 400, 'BAD_METAL');
  await db.query(`update rate_snapshots set fetched_at = now() - interval '10 minutes'`);
  ok(await call('POST', '/api/v1/locks', { token, body: { products: ['s-1t'] } }));                   // fetches a new rate, which fires the alert
  const alerts = ok(await call('GET', '/api/v1/alerts', { token })).alerts;
  assert.ok(alerts[0].fired_at);
  const n = ok(await call('GET', '/api/v1/notifications', { token })).notifications;
  assert.ok(n.some(x => x.kind === 'alert' || /gold/i.test(x.title)));
  ok(await call('POST', '/api/v1/notifications/read', { token, body: {} }));
  assert.equal(ok(await call('GET', '/api/v1/me', { token })).unread, 0);
  ok(await call('DELETE', `/api/v1/alerts/${a.id}`, { token }));
  assert.equal(ok(await call('GET', '/api/v1/alerts', { token })).alerts.length, 0);
});

test('closing the account: blocked while holding metal, then closes and frees the number', async () => {
  const token = await verified('3001110009', '10.0.9.1');
  await buy(token, 'g-10mg', 1);
  const blocked = ok(await call('POST', '/api/v1/account/close', { token, body: {} }));
  assert.equal(blocked.closed, false); assert.equal(blocked.blockers[0].code, 'HOLDINGS');
  const fresh = await login('3001110010', '10.0.10.1');
  const closed = ok(await call('POST', '/api/v1/account/close', { token: fresh, body: {} }));
  assert.equal(closed.closed, true);
  err(await call('GET', '/api/v1/me', { token: fresh }), 401, 'SESSION_EXPIRED');
  await db.query(`delete from rate_limits where key like 'otp-send-30s:3001110010'`);
  const again = ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3001110010', code: '123456', cookie: false }, ip: '10.0.10.2' }));
  assert.equal(again.customer.isNew, true, 'the number can open a new account');
});

test('staff sign-in needs password and authenticator code', async () => {
  const s = await staffAccount('admin');
  err(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: 'wrong' }, ip: '10.9.1.1' }), 401, 'BAD_LOGIN');
  err(await call('POST', '/api/v1/staff/login', { body: { email: 'nobody@pgbx.test', password: 'x' }, ip: '10.9.1.1' }), 401, 'BAD_LOGIN');
  const { token } = ok(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: s.password }, ip: '10.9.1.1' }));
  err(await call('GET', '/api/v1/admin/overview', { token }), 401, 'MFA_REQUIRED');
  err(await call('POST', '/api/v1/staff/mfa', { token, body: { code: '000000' } }), 401, 'BAD_CODE');
  ok(await call('POST', '/api/v1/staff/mfa', { token, body: { code: totp(s.secret) } }));
  assert.equal(ok(await call('GET', '/api/v1/staff/me', { token })).staff.role, 'admin');
  ok(await call('POST', '/api/v1/staff/logout', { token, body: {} }));
  err(await call('GET', '/api/v1/staff/me', { token }), 401, 'SESSION_EXPIRED');
});

test('staff sign-in is rate limited per email', async () => {
  const s = await staffAccount('ops');
  for (let i = 0; i < 8; i++) err(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: 'wrong' }, ip: '10.9.2.' + i }), 401);
  err(await call('POST', '/api/v1/staff/login', { body: { email: s.email, password: s.password }, ip: '10.9.2.99' }), 429, 'RATE_LIMITED');
});

test('admin: overview, settings, products, dealers, stock, staff', async () => {
  const admin = await staffLogin(await staffAccount('admin'), '10.9.3.1');
  const opsToken = await staffLogin(await staffAccount('ops'), '10.9.3.2');
  const ov = ok(await call('GET', '/api/v1/admin/overview', { token: opsToken }));
  assert.ok(ov.customers > 0);
  err(await call('PATCH', '/api/v1/admin/settings', { token: opsToken, body: { max_units_per_order: 5 } }), 403, 'FORBIDDEN');
  err(await call('PATCH', '/api/v1/admin/settings', { token: admin, body: { nonsense: 1 } }), 400, 'BAD_SETTING');
  ok(await call('PATCH', '/api/v1/admin/settings', { token: admin, body: { max_units_per_order: 12 } }));
  assert.equal(ok(await call('GET', '/api/v1/admin/settings', { token: opsToken })).settings.find(s => s.key === 'max_units_per_order').value, 12);
  ok(await call('PATCH', '/api/v1/admin/settings', { token: admin, body: { max_units_per_order: 10 } }));
  assert.equal(ok(await call('PATCH', '/api/v1/admin/products/g-1g', { token: admin, body: { premium_pkr: 1300 } })).product.premium_pkr, 1300);
  ok(await call('PATCH', '/api/v1/admin/products/g-1g', { token: admin, body: { premium_pkr: 1200 } }));
  ok(await call('POST', '/api/v1/admin/dealers', { token: admin, body: { id: 'd9', name: 'New Counter', area: 'Lahore' } }));
  ok(await call('PUT', '/api/v1/admin/dealers/d9/stock', { token: opsToken, body: { product_id: 'g-1g', units: 7 } }));
  const d9 = ok(await call('GET', '/api/v1/admin/dealers', { token: opsToken })).dealers.find(d => d.id === 'd9');
  assert.equal(d9.stock['g-1g'], 7);
  ok(await call('PATCH', '/api/v1/admin/dealers/d9', { token: admin, body: { active: false } }));
  assert.ok(!ok(await call('GET', '/api/v1/dealers')).dealers.some(d => d.id === 'd9'));
  const created = ok(await call('POST', '/api/v1/admin/staff', { token: admin, body: { email: 'new@pgbx.test', name: 'New Person', role: 'ops' } }));
  assert.ok(created.setup.password && created.setup.totpSecret);
  const fresh = await staffLogin({ email: 'new@pgbx.test', password: created.setup.password, secret: created.setup.totpSecret }, '10.9.3.3');
  ok(await call('POST', `/api/v1/admin/staff/${created.staff.id}/active`, { token: admin, body: { active: false } }));
  err(await call('GET', '/api/v1/admin/overview', { token: fresh }), 401, 'SESSION_EXPIRED');
  const audit = ok(await call('GET', '/api/v1/admin/audit', { token: opsToken })).entries;
  assert.ok(audit.some(a => a.action === 'setting.changed') && audit.some(a => a.action === 'staff.deactivated'));
});

test('admin: identity review, flagged orders, customer suspension, reconciliation', async () => {
  const opsToken = await staffLogin(await staffAccount('ops'), '10.9.4.1');
  const admin = await staffLogin(await staffAccount('admin'), '10.9.4.2');
  const queue = ok(await call('GET', '/api/v1/admin/kyc', { token: opsToken })).checks;
  const check = queue.find(k => k.name === 'Please Review Me');
  ok(await call('POST', `/api/v1/admin/kyc/${check.id}/decide`, { token: opsToken, body: { decision: 'passed' } }));
  err(await call('POST', `/api/v1/admin/kyc/${check.id}/decide`, { token: opsToken, body: { decision: 'passed' } }), 404);
  const flagged = ok(await call('GET', '/api/v1/admin/orders', { token: opsToken })).orders;
  assert.ok(flagged.length >= 1);
  const resolved = ok(await call('POST', `/api/v1/admin/orders/${flagged[0].id}/resolve`, { token: opsToken, body: { action: 'refund', note: 'Amount did not match' } }));
  assert.equal(resolved.order.status, 'refunded');
  const customers = ok(await call('GET', '/api/v1/admin/customers?q=3001110004', { token: opsToken })).customers;
  assert.equal(customers.length, 1);
  const detail = ok(await call('GET', `/api/v1/admin/customers/${customers[0].id}`, { token: opsToken }));
  assert.equal(detail.wallet.holdings[0].units, 2);
  err(await call('POST', `/api/v1/admin/customers/${customers[0].id}/status`, { token: opsToken, body: { status: 'suspended' } }), 403);
  ok(await call('POST', `/api/v1/admin/customers/${customers[0].id}/status`, { token: admin, body: { status: 'suspended', reason: 'Test' } }));
  err(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: '3001110004', code: '123456' }, ip: '10.0.4.9' }), 403, 'ACCOUNT_INACTIVE');
  ok(await call('POST', `/api/v1/admin/customers/${customers[0].id}/status`, { token: admin, body: { status: 'active' } }));
  ok(await call('POST', '/api/v1/admin/vault', { token: opsToken, body: { product_id: 'g-1g', units: 498 } }));
  const rec = ok(await call('GET', '/api/v1/admin/reconciliation', { token: opsToken })).reconciliation;
  assert.ok(rec);
});

test('scheduled job needs its secret and runs the expiry sweep', async () => {
  err(await call('GET', '/api/v1/cron/sweep'), 401);
  const r = ok(await call('GET', '/api/v1/cron/sweep', { headers: { authorization: 'Bearer cron-test' } }));
  assert.equal(typeof r.expired_orders, 'number');
  assert.equal(typeof r.pushed, 'number');
});

test('without a database the API says it is not connected', async () => {
  const s = http.createServer((req, res) => handle(req, res, { db: null }));
  // handle() falls back to getDb() when db is falsy; with no DATABASE_URL that is null
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await (await fetch(b + '/api/v1/config')).json()).live, false);
  const r = await fetch(b + '/api/v1/products');
  assert.equal(r.status, 503);
  s.close();
});
