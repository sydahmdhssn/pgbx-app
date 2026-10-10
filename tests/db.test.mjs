// Business rules enforced by the database itself (supabase/migrations). Runs on PGlite: `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../server/memory-db.mjs';

let db;
const rejects = async (p, code) => assert.rejects(p, e => e.message.includes(code), `expected ${code}`);
const customer = async (phone, kyc = 'verified') =>
  (await db.one(`insert into customers (phone, name, cnic, kyc_status) values ($1, 'Test Customer', '42101-' || right($1, 7) || '-1', $2) returning id`, [phone, kyc])).id;
const rates = (gold = 435000, silver = 6400) => db.one(`select fn_record_rates($1, $2, $3, $4, 'test') as id`, [gold, Math.round(gold * 0.988), silver, Math.round(silver * 0.975)]);
const lock = (c, products) => db.one(`select * from fn_create_lock($1, $2)`, [c, products]);
const order = (c, l, lines, key) => db.one(`select * from fn_place_order($1, $2, $3::jsonb, 'bank', $4)`, [c, l, JSON.stringify(lines), key]);
const paid = (o, amount, ref = 'ref-' + o.id) => db.one(`select * from fn_payment_succeeded('sandbox', $1, $2, $3)`, [ref, o.id, amount ?? o.total_pkr]);
const holdings = async (c, p) => (await db.one(`select holdings_of($1, $2) as n`, [c, p])).n;
const dealerStaff = async dealer => (await db.one(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret) values ($1, 'Dealer', 'dealer', $2, 'x', 'x') returning id`, [`d-${dealer}-${Math.random()}@pgbx.test`, dealer])).id;
const buy = async (c, pid, units) => { const l = await lock(c, [pid]); const o = await order(c, l.id, [{ product_id: pid, units }], 'k' + Math.random()); return paid(o); };

before(async () => { db = await createMemoryDb(); await db.query(`update settings set value = 'false' where key = 'rate_chat_required'`); await rates(); });
after(async () => db.close());

test('the ledger and audit log cannot be edited or deleted', async () => {
  const c = await customer('3000000001');
  await buy(c, 'g-1g', 1);
  await rejects(db.query(`update ledger set delta = 99 where customer_id = $1`, [c]), 'LEDGER_APPEND_ONLY');
  await rejects(db.query(`delete from ledger where customer_id = $1`, [c]), 'LEDGER_APPEND_ONLY');
  await rejects(db.query(`delete from audit_log`), 'AUDIT_APPEND_ONLY');
});

test('prices come from the latest server rate and lock for 60 seconds', async () => {
  const c = await customer('3000000002');
  await rates(466560, 6400);                                   // 466,560 per tola = 40,000 per gram
  const l = await lock(c, ['g-1g', 's-1t']);
  assert.equal(l.prices['g-1g'], 40000 + 1200);
  assert.equal(l.prices['s-1t'], 6400 + 350);
  assert.ok(new Date(l.expires_at) - new Date(l.created_at) >= 59000);
  await db.query(`update rate_snapshots set fetched_at = now() - interval '5 minutes'`);
  await rejects(lock(c, ['g-1g']), 'RATES_STALE');             // no buying on old prices (FR-R4)
  await rates();
});

test('orders need verified identity, respect limits and never duplicate', async () => {
  const unverified = await customer('3000000003', 'none');
  await rejects(order(unverified, (await lock(unverified, ['g-1g'])).id, [{ product_id: 'g-1g', units: 1 }], 'a'), 'KYC_REQUIRED');
  const c = await customer('3000000004');
  const l = await lock(c, ['g-10mg']);
  const o1 = await order(c, l.id, [{ product_id: 'g-10mg', units: 2 }], 'same-key');
  const o2 = await order(c, l.id, [{ product_id: 'g-10mg', units: 2 }], 'same-key');
  assert.equal(o1.id, o2.id, 'same request returns the same order');
  assert.equal((await db.one(`select count(*)::int n from orders where customer_id = $1`, [c])).n, 1);
  await rejects(order(c, l.id, [{ product_id: 'g-10mg', units: 11 }], 'big'), 'ORDER_LIMIT');
  await rejects(order(c, l.id, [{ product_id: 'g-1g', units: 1 }], 'notlocked'), 'PRODUCT_NOT_LOCKED');
  const l5 = await lock(c, ['g-5g']);
  await rejects(order(c, l5.id, [{ product_id: 'g-5g', units: 9 }], 'daily'), 'DAILY_LIMIT');
  await db.query(`update price_locks set expires_at = now() - interval '1 second' where id = $1`, [l.id]);
  await rejects(order(c, l.id, [{ product_id: 'g-10mg', units: 1 }], 'late'), 'LOCK_EXPIRED');
});

test('a payment credits the wallet exactly once', async () => {
  const c = await customer('3000000005');
  const l = await lock(c, ['g-1g']);
  const o = await order(c, l.id, [{ product_id: 'g-1g', units: 2 }], 'pay1');
  const first = await paid(o);
  assert.equal(first.status, 'credited');
  const again = await paid(o);                                  // the provider retries its webhook
  assert.equal(again.status, 'credited');
  assert.equal(await holdings(c, 'g-1g'), 2, 'credited once, not twice');
  const n = await db.one(`select count(*)::int n from notifications where customer_id = $1 and title = 'Purchase confirmed'`, [c]);
  assert.equal(n.n, 1);
});

test('wrong amounts and late payments are held for operations, then resolved', async () => {
  const c = await customer('3000000006');
  const l = await lock(c, ['s-1t']);
  const o = await order(c, l.id, [{ product_id: 's-1t', units: 1 }], 'mismatch');
  const r = await paid(o, o.total_pkr - 1);
  assert.equal(r.status, 'flagged');
  assert.equal(await holdings(c, 's-1t'), 0, 'nothing credited on a wrong amount');
  const admin = (await db.one(`insert into staff (email, name, role, password_hash, totp_secret) values ('ops@pgbx.test', 'Ops', 'ops', 'x', 'x') returning id`)).id;
  const done = await db.one(`select * from fn_resolve_order($1, $2, 'credit', 'Checked with bank')`, [admin, o.id]);
  assert.equal(done.status, 'credited');
  assert.equal(await holdings(c, 's-1t'), 1);
  const l2 = await lock(c, ['s-1t']);
  const o2 = await order(c, l2.id, [{ product_id: 's-1t', units: 1 }], 'late');
  await db.query(`update orders set created_at = now() - interval '2 hours' where id = $1`, [o2.id]);
  await db.one(`select fn_expire_orders() n`);
  assert.equal((await paid(o2)).status, 'flagged', 'money after expiry goes to operations, not lost');
});

test('reserving needs metal you own and stock at the dealer', async () => {
  const c = await customer('3000000007');
  await buy(c, 'g-1g', 2);
  const reserve = (p, u, d, code) => db.one(`select * from fn_reserve($1, $2, $3, $4, $5)`, [c, p, u, d, code]);
  await rejects(reserve('g-1g', 3, 'd1', '100001'), 'INSUFFICIENT_HOLDINGS');
  await rejects(reserve('g-1g', 1, 'd3', '100002'), 'OUT_OF_STOCK');   // d3 has no 1 g gold in the sample data
  const r = await reserve('g-1g', 2, 'd1', '100003');
  assert.equal(r.status, 'requested');
  await rejects(reserve('g-1g', 1, 'd1', '100004'), 'INSUFFICIENT_HOLDINGS');   // both units already reserved
  const c2 = await customer('3000000008');
  await buy(c2, 'g-1g', 1);
  await rejects(db.one(`select * from fn_reserve($1, 'g-1g', 1, 'd1', '100003')`, [c2]), 'redemptions_active_code');   // codes are unique while active
  await db.one(`select * from fn_cancel_redemption($1, $2)`, [c, r.id]);
  assert.ok(await reserve('g-1g', 1, 'd1', '100005'), 'cancelled units are free again');
});

test('dealer hand-over: own dealer only, CNIC checked, serials recorded, code works once', async () => {
  const c = await customer('3000000009');
  await buy(c, 's-5t', 2);
  const r = await db.one(`select * from fn_reserve($1, 's-5t', 2, 'd1', '200001')`, [c]);
  const other = await dealerStaff('d2'), mine = await dealerStaff('d1');
  await rejects(db.one(`select fn_dealer_lookup($1, '200001') r`, [other]), 'CODE_NOT_FOUND');
  const look = (await db.one(`select fn_dealer_lookup($1, '200001') r`, [mine])).r;
  assert.equal(look.units, 2);
  assert.equal(look.cnic_masked, '42101-•••••••-1');
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, true, (select code from redemptions where id = $2))`, [mine, r.id, ['A1', 'A2']]), 'REDEMPTION_NOT_READY');
  await db.one(`select * from fn_dealer_ready($1, $2)`, [mine, r.id]);
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, false, (select code from redemptions where id = $2))`, [mine, r.id, ['A1', 'A2']]), 'CNIC_NOT_CHECKED');
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, true, (select code from redemptions where id = $2))`, [mine, r.id, ['A1']]), 'SERIALS_REQUIRED');
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, true, '000000')`, [mine, r.id, ['A1', 'A2']]), 'CODE_NOT_FOUND');   // the customer's code is needed
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, true, null)`, [mine, r.id, ['A1', 'A2']]), 'CODE_NOT_FOUND');
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, true, (select code from redemptions where id = $2))`, [mine, r.id, ['A1', 'A1']]), 'SERIALS_REQUIRED');
  const stockBefore = (await db.one(`select units from dealer_stock where dealer_id = 'd1' and product_id = 's-5t'`)).units;
  const done = await db.one(`select * from fn_dealer_handover($1, $2, $3, true, (select code from redemptions where id = $2))`, [mine, r.id, ['AG-5T-0001', 'AG-5T-0002']]);
  assert.equal(done.status, 'completed');
  assert.equal(await holdings(c, 's-5t'), 0, 'wallet reduced through the ledger');
  assert.equal((await db.one(`select units from dealer_stock where dealer_id = 'd1' and product_id = 's-5t'`)).units, stockBefore - 2);
  await rejects(db.one(`select fn_dealer_lookup($1, '200001') r`, [mine]), 'CODE_NOT_FOUND');   // single use (Rule 5)
});

test('expired codes release the reservation', async () => {
  const c = await customer('3000000010');
  await buy(c, 'g-100mg', 1);
  const r = await db.one(`select * from fn_reserve($1, 'g-100mg', 1, 'd1', '300001')`, [c]);
  await db.query(`update redemptions set expires_at = now() - interval '1 minute' where id = $1`, [r.id]);
  assert.equal((await db.one(`select fn_expire_redemptions() n`)).n, 1);
  assert.equal((await db.one(`select reserved_of($1, 'g-100mg') n`, [c])).n, 0);
});

test('price alerts fire once when the rate crosses the target', async () => {
  const c = await customer('3000000011');
  await db.query(`insert into price_alerts (customer_id, metal, dir, target_pkr) values ($1, 'gold', 'above', 440000)`, [c]);
  await rates(439000);
  assert.equal((await db.one(`select count(*)::int n from notifications where customer_id = $1 and kind = 'alert'`, [c])).n, 0);
  await rates(441000); await rates(442000);
  assert.equal((await db.one(`select count(*)::int n from notifications where customer_id = $1 and kind = 'alert'`, [c])).n, 1);
  await rates();
});

test('closing an account: blocked while holding metal, then closes and frees the number', async () => {
  const c = await customer('3000000012');
  await buy(c, 'g-10mg', 1);
  await db.query(`insert into sessions (token_hash, customer_id, expires_at) values ('t-close', $1, now() + interval '1 day')`, [c]);
  const blocked = (await db.one(`select fn_close_account($1) r`, [c])).r;
  assert.equal(blocked.closed, false);
  assert.equal(blocked.blockers[0].code, 'HOLDINGS');
  const s = await dealerStaff('d1');
  const r = await db.one(`select * from fn_reserve($1, 'g-10mg', 1, 'd1', '400001')`, [c]);
  await db.one(`select * from fn_dealer_ready($1, $2)`, [s, r.id]);
  await db.one(`select * from fn_dealer_handover($1, $2, $3, true, (select code from redemptions where id = $2))`, [s, r.id, ['AU-10MG-1']]);
  await db.query(`update settings set value = '0' where key = 'retention_days'`);
  const ok = (await db.one(`select fn_close_account($1) r`, [c])).r;
  assert.equal(ok.closed, true);
  const row = await db.one(`select phone, closed_phone, status from customers where id = $1`, [c]);
  assert.equal(row.phone, null); assert.equal(row.closed_phone, '3000000012'); assert.equal(row.status, 'closed');
  assert.ok((await db.one(`select revoked_at from sessions where token_hash = 't-close'`)).revoked_at, 'logged out everywhere');
  assert.ok(await customer('3000000012'), 'the number can open a new account');
  await db.query(`update customers set purge_after = now() - interval '1 second' where id = $1`, [c]);
  assert.equal((await db.one(`select fn_purge_closed() n`)).n, 1);
  const gone = await db.one(`select name, cnic, closed_phone from customers where id = $1`, [c]);
  assert.deepEqual(gone, { name: null, cnic: null, closed_phone: null });
  assert.ok((await db.one(`select count(*)::int n from ledger where customer_id = $1`, [c])).n > 0, 'records kept without personal data');
  await db.query(`update settings set value = 'null' where key = 'retention_days'`);
});

test('reconciliation matches payments, orders and metal', async () => {
  const rec = (await db.one(`select fn_reconcile(pk_today()) r`)).r;
  assert.ok(rec.payments_succeeded_pkr > 0 && rec.orders_credited_pkr > 0);
  assert.ok(rec.paid_not_credited.some(o => o.status === 'flagged'), 'the late payment from earlier is listed for operations');
  assert.ok(Array.isArray(rec.metal) && rec.metal.length === 11);
  const g1 = rec.metal.find(m => m.product_id === 'g-1g');
  assert.equal(g1.vault_units, 500);
  assert.ok(g1.customer_units >= 1);
  assert.equal(rec.credited_without_payment.length, 0);
});

test('shared rate limit blocks after the maximum and reports the wait', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await db.one(`select fn_rate_limit('otp:3001112222', 3600, 3) w`)).w, 0);
  assert.ok((await db.one(`select fn_rate_limit('otp:3001112222', 3600, 3) w`)).w > 0);
});

test('a payment after the payment window is never credited at the old price', async () => {
  const c = await customer('3000000099');
  const l = await lock(c, ['g-1g']);
  const o = await order(c, l.id, [{ product_id: 'g-1g', units: 1 }], 'late-window');
  await db.query(`update orders set created_at = now() - interval '6 hours' where id = $1`, [o.id]);
  const r = await paid(o);
  assert.equal(r.status, 'flagged');
  assert.equal(await holdings(c, 'g-1g'), 0);
});

test('order lines must be whole, sane numbers and not repeat a product', async () => {
  const c = await customer('3000000098');
  const l = await lock(c, ['g-1g']);
  await rejects(order(c, l.id, [{ product_id: 'g-1g', units: 1.5 }], 'f1'), 'BAD_UNITS');
  await rejects(order(c, l.id, [{ product_id: 'g-1g', units: 1e12 }], 'f2'), 'BAD_UNITS');
  await rejects(order(c, l.id, [{ product_id: 'g-1g', units: 1 }, { product_id: 'g-1g', units: 1 }], 'f3'), 'DUPLICATE_LINE');
});

test('a suspended customer can’t collect at a dealer', async () => {
  const c = await customer('3000000097');
  await buy(c, 'g-10mg', 1);
  const r = await db.one(`select * from fn_reserve($1, 'g-10mg', 1, 'd1', '771177')`, [c]);
  const s = await dealerStaff('d1');
  await db.query(`update customers set status = 'suspended' where id = $1`, [c]);
  await rejects(db.one(`select fn_dealer_lookup($1, '771177') r`, [s]), 'ACCOUNT_INACTIVE');
  await db.query(`update redemptions set status = 'ready' where id = $1`, [r.id]);
  await rejects(db.one(`select * from fn_dealer_handover($1, $2, $3, true, (select code from redemptions where id = $2))`, [s, r.id, ['SN1']]), 'ACCOUNT_INACTIVE');
});
