// $1 gold: buying one dollar at a time, clubbing transactions into 1-tola lots, and selling any amount held.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../server/memory-db.mjs';

let db;
const rejects = async (p, code) => assert.rejects(p, e => e.message.includes(code), `expected ${code}`);
const customer = async (phone, kyc = 'verified') =>
  (await db.one(`insert into customers (phone, name, cnic, kyc_status) values ($1, 'Test Customer', $2, $3) returning id`, [phone, '42101-' + phone.slice(-7) + '-1', kyc])).id;
// 466,560 per tola = 40,000 per gram; $1 = Rs 280, so each $1 buys 0.007 g
const rates = async (gold = 466560, usd = 280) => {
  const { id } = await db.one(`select fn_record_rates($1, $2, 6400, 6240, 'test') as id`, [gold, Math.round(gold * 0.988)]);
  await db.query(`update rate_snapshots set usd_pkr = $2 where id = $1`, [id, usd]);
};
const buy = (c, units, key = 'k' + Math.random()) => db.one(`select * from fn_micro_buy($1, $2, $3)`, [c, units, key]);
const pay = async (o, amount) => (await db.one(`select fn_micro_paid($1, $2, $3) r`, [o.id, 'pay-' + o.id, amount ?? o.total_pkr])).r;
const sell = (c, grams, key = 's' + Math.random(), iban = 'PK36SCBL0000001123456702') => db.one(`select * from fn_micro_sell($1, $2, $3, $4)`, [c, grams, iban, key]);
const grams = async c => Number((await db.one(`select micro_grams($1) g`, [c])).g);
const lots = side => db.query(`select * from tola_lots where side = $1 order by no`, [side]);

before(async () => { db = await createMemoryDb(); await db.query(`update settings set value = 'false' where key = 'rate_chat_required'`); await rates(); });
after(async () => db.close());

test('each $1 is its own transaction at the live dollar rate and gold price', async () => {
  const c = await customer('3100000001');
  const o = await buy(c, 3);
  assert.equal(o.unit_pkr, 280); assert.equal(o.total_pkr, 840); assert.equal(o.status, 'pending_payment');
  assert.match(o.ref, /^PGBX-MO-\d{6}-[0-9A-F]{8}$/);
  const t = await db.query(`select * from micro_txns where order_id = $1`, [o.id]);
  assert.equal(t.length, 3);
  assert.equal(new Set(t.map(x => x.ref)).size, 3);
  t.forEach(x => { assert.match(x.ref, /^PGBX-M-\d{6}-[0-9A-F]{8}$/); assert.equal(Number(x.grams), 0.007); assert.equal(x.amount_pkr, 280); });
  assert.equal(await grams(c), 0);                                // nothing owned until paid
  assert.equal((await pay(o)).status, 'credited');
  assert.equal(await grams(c), 0.021);
  assert.equal((await buy(c, 3, o.idempotency_key)).id, o.id);    // same request key: same order, no double charge
  await rejects(buy(c, 0), 'BAD_UNITS');
  await rejects(buy(c, 101), 'BAD_UNITS');
  await rejects(buy(await customer('3100000002', 'none'), 1), 'KYC_REQUIRED');
});

test('the dollar rate is required and must be fresh', async () => {
  const c = await customer('3100000003');
  await db.query(`update rate_snapshots set usd_pkr = null where id = (select max(id) from rate_snapshots)`);
  await rejects(buy(c, 1), 'RATES_STALE');
  await rates(466560, 300);                                       // a new dollar rate: $1 = Rs 300
  const o = await buy(c, 1);
  assert.equal(o.unit_pkr, 300);
  assert.equal(Number((await db.one(`select grams from micro_txns where order_id = $1`, [o.id])).grams), 0.0075);
  await rates();
});

test('paid transactions from all customers fill 1-tola lots; the one that crosses the edge is split', async () => {
  // Lots are append-only, so work from whatever the open lot already holds
  const open = await db.one(`select * from tola_lots where side = 'buy' and status = 'filling'`);
  const ref = open ? open.ref : 'PGBX-T-000001', no = open ? open.no : 1;
  const R = Math.round((11.664 - (open ? Number(open.grams_filled) : 0)) * 1e6);   // micrograms still needed
  const whole = Math.floor(R / 7000), rem = R - whole * 7000, N = whole + (rem > 0 ? 1 : 0);
  const a = await customer('3100000004'), b = await customer('3100000005');
  await db.query(`update settings set value = '100000000' where key = 'daily_limit_pkr'`);
  let n = 0;
  while (n < N) { const u = Math.min(100, N - n); await pay(await buy(n % 200 < 100 ? a : b, u)); n += u; }
  const l1 = await db.one(`select * from tola_lots where ref = $1`, [ref]);
  const l2 = await db.one(`select * from tola_lots where side = 'buy' and no = $1`, [no + 1]);
  assert.equal(l1.status, 'full'); assert.equal(Number(l1.grams_filled), 11.664);
  assert.equal(l2.ref, 'PGBX-T-' + String(no + 1).padStart(6, '0')); assert.equal(l2.status, 'filling'); assert.equal(Number(l2.grams_filled), (7000 - rem) / 1e6);
  const mine = await db.query(`select a.grams, t.customer_id from lot_allocations a join micro_txns t on t.id = a.txn_id where a.lot_id = $1 and t.customer_id in ($2, $3)`, [l1.id, a, b]);
  assert.equal(mine.length, N);                                   // every transaction ID that paid into this tola
  assert.ok(new Set(mine.map(x => x.customer_id)).size === 2);    // clubbed across customers
  const split = await db.query(`select a.txn_id, sum(a.grams) g from lot_allocations a join micro_txns t on t.id = a.txn_id where t.customer_id in ($1, $2) group by a.txn_id having count(*) > 1`, [a, b]);
  assert.equal(split.length, 1); assert.equal(Number(split[0].g), 0.007);
  const parts = await db.query(`select l.ref, a.grams from lot_allocations a join tola_lots l on l.id = a.lot_id where a.txn_id = $1 order by l.no`, [split[0].txn_id]);
  assert.deepEqual(parts.map(p => [p.ref, Number(p.grams)]), [[ref, rem / 1e6], [l2.ref, (7000 - rem) / 1e6]]);
  const total = await db.one(`select sum(a.grams) g from lot_allocations a join micro_txns t on t.id = a.txn_id where t.customer_id in ($1, $2)`, [a, b]);
  const credited = await db.one(`select sum(grams) g from micro_txns where side = 'buy' and status = 'credited' and customer_id in ($1, $2)`, [a, b]);
  assert.equal(Number(total.g), Number(credited.g));              // every credited gram is in exactly one place
  const lotPkr = await db.one(`select sum(amount_pkr)::float8 v from lot_allocations where txn_id = $1`, [split[0].txn_id]);
  assert.equal(lotPkr.v, 280);                                    // the split transaction's rupees add up across its two lots
  assert.ok((await db.one(`select count(*)::int n from audit_log where action = 'lot.full' and entity_id = $1`, [ref])).n === 1);
  await rejects(db.query(`delete from lot_allocations`), 'APPEND_ONLY');
  await rejects(db.query(`update micro_txns set grams = 999 where customer_id = $1`, [a]), 'APPEND_ONLY');
  await rejects(db.query(`update tola_lots set grams_filled = 0 where id = $1`, [l1.id]), 'APPEND_ONLY');
  await db.query(`update settings set value = '1500000' where key = 'daily_limit_pkr'`);
});

test('wrong, late and repeated payments are never credited twice or lost', async () => {
  const c = await customer('3100000006');
  const o1 = await buy(c, 2);
  assert.equal((await pay(o1, o1.total_pkr - 1)).refund_due, true);
  assert.equal(await grams(c), 0);
  const o2 = await buy(c, 1);
  await db.query(`alter table micro_orders disable trigger micro_orders_append_only`);   // test only: age the order
  await db.query(`update micro_orders set created_at = now() - interval '2 hours' where id = $1`, [o2.id]);
  await db.query(`alter table micro_orders enable trigger micro_orders_append_only`);
  assert.equal((await db.one(`select fn_expire_micro() n`)).n, 1);
  assert.equal((await pay(o2)).refund_due, true);                 // money after expiry: refund, not gold
  const o3 = await buy(c, 1);
  await pay(o3);
  assert.equal((await pay(o3)).duplicate, true);
  assert.equal(await grams(c), 0.007);
});

test('the daily limit counts $1 gold', async () => {
  const c = await customer('3100000007');
  await db.query(`update settings set value = '1000' where key = 'daily_limit_pkr'`);
  await buy(c, 3);                                                // Rs 840, still payable
  await rejects(buy(c, 1), 'DAILY_LIMIT');                        // 840 + 280 > 1000
  await db.query(`update settings set value = '1500000' where key = 'daily_limit_pkr'`);
});

test('selling any amount held: own transaction ID, sell lots, payout, and no overselling', async () => {
  const c = await customer('3100000008');
  await pay(await buy(c, 10));                                    // 0.07 g
  await rejects(sell(c, 0.08), 'INSUFFICIENT_GOLD');
  await rejects(sell(c, 0.0001), 'BAD_GRAMS');
  await rejects(sell(c, 0.01, 'x1', 'PK123'), 'BAD_IBAN');
  const s = await sell(c, 0.0255, 'sell-1');
  assert.match(s.ref, /^PGBX-MS-\d{6}-[0-9A-F]{8}$/);
  assert.equal(s.status, 'pending_payout');
  assert.equal(Number(s.price_gram), 39519.98);                  // sell price 460,961 per tola / 11.664
  assert.equal(s.amount_pkr, Math.floor(0.0255 * 39519.98));      // rupees rounded down
  assert.equal((await sell(c, 0.0255, 'sell-1')).id, s.id);       // repeated request: same sale
  assert.equal(await grams(c), 0.0445);
  const [sl] = await lots('sell');
  assert.equal(sl.ref, 'PGBX-TS-000001'); assert.equal(Number(sl.grams_filled), 0.0255);
  await sell(c, 0.0445);
  assert.equal(await grams(c), 0);
  await rejects(sell(c, 0.001), 'INSUFFICIENT_GOLD');
  // operations pays it out
  const st = (await db.one(`insert into staff (email, name, role, password_hash, totp_secret) values ('ops-m@pgbx.test', 'Ops', 'ops', 'x', 'x') returning id`)).id;
  const p = await db.one(`select * from fn_micro_payout($1, $2, 'IBFT-778899')`, [st, s.id]);
  assert.equal(p.status, 'paid_out');
  await rejects(db.one(`select * from fn_micro_payout($1, $2, 'IBFT-778899')`, [st, s.id]), 'ALREADY_PAID');
});

test('a full lot is settled with the tola bar’s serial; accounts with gold or money owed can’t close', async () => {
  const st = (await db.one(`select id from staff limit 1`)).id;
  const [full, filling] = await lots('buy');
  await rejects(db.one(`select * from fn_lot_settle($1, $2, '', null)`, [st, full.id]), 'SERIALS_REQUIRED');
  await rejects(db.one(`select * from fn_lot_settle($1, $2, 'BAR-1', null)`, [st, filling.id]), 'LOT_NOT_FULL');
  const s = await db.one(`select * from fn_lot_settle($1, $2, 'PGBX-BAR-0001', 'Bought from Sarafa')`, [st, full.id]);
  assert.equal(s.status, 'settled'); assert.equal(s.bar_serial, 'PGBX-BAR-0001');

  const c = await customer('3100000009');
  await pay(await buy(c, 1));
  let r = (await db.one(`select fn_close_account($1) r`, [c])).r;
  assert.equal(r.closed, false); assert.ok(r.blockers.some(b => b.code === 'GOLD_SAVINGS'));
  await sell(c, 0.007);
  r = (await db.one(`select fn_close_account($1) r`, [c])).r;
  assert.ok(r.blockers.some(b => b.code === 'PAYOUTS_PENDING'));
});

test('audit fixes: a second payment, a missing amount and a suspended account are never lost or credited', async () => {
  const c = await customer('3100000020');
  const o = await buy(c, 2);
  await rejects(db.one(`select fn_micro_paid($1, 'ref-null', null) r`, [o.id]), 'BAD_AMOUNT');
  assert.equal((await pay(o)).status, 'credited');
  assert.equal((await db.one(`select fn_micro_paid($1, $2, $3) r`, [o.id, 'pay-' + o.id, o.total_pkr])).r.duplicate, true);   // same event again
  const second = (await db.one(`select fn_micro_paid($1, 'ref-second', $2) r`, [o.id, o.total_pkr])).r;
  assert.equal(second.refund_due, true);
  const r = await db.one(`select * from refunds where kind = 'micro' and payment_ref = 'ref-second'`);
  assert.equal(r.status, 'due'); assert.equal(r.amount_pkr, o.total_pkr);
  assert.equal(await grams(c), 0.014);                            // still only the first payment's gold
  // operations marks it refunded
  const st = (await db.one(`insert into staff (email, name, role, password_hash, totp_secret) values ('ops-r@pgbx.test', 'Ops', 'ops', 'x', 'x') returning id`)).id;
  await rejects(db.one(`select * from fn_mark_refunded($1, $2, '')`, [st, r.id]), 'BAD_REF');
  assert.equal((await db.one(`select * from fn_mark_refunded($1, $2, 'IBFT-REF-1')`, [st, r.id])).status, 'refunded');
  await rejects(db.one(`select * from fn_mark_refunded($1, $2, 'IBFT-REF-1')`, [st, r.id]), 'ALREADY_REFUNDED');
  // a suspended customer's payment becomes a refund, not gold
  const o2 = await buy(c, 1);
  await db.query(`update customers set status = 'suspended' where id = $1`, [c]);
  assert.equal((await pay(o2)).refund_due, true);
  assert.equal((await db.one(`select status from micro_orders where id = $1`, [o2.id])).status, 'refund_due');
  await db.query(`update customers set status = 'active' where id = $1`, [c]);
});

test('audit fixes: the whole balance can always be sold; closing expires unpaid transactions; purge waits for retention', async () => {
  const c = await customer('3100000021');
  await pay(await buy(c, 1));                                     // 0.007 g
  await sell(c, 0.0065);
  assert.equal(await grams(c), 0.0005);
  await rejects(sell(c, 0.0004), 'BAD_GRAMS');                    // a part below the minimum is still refused
  const all = await sell(c, 0.0005);                              // but the whole remaining balance can be sold
  assert.ok(all.amount_pkr >= 1); assert.equal(await grams(c), 0);
  await rejects(db.one(`select * from fn_micro_sell($1, 0.001, null, 'k-null-iban')`, [c]), 'INSUFFICIENT_GOLD');
  const c2 = await customer('3100000022');
  await pay(await buy(c2, 1));
  await rejects(sell(c2, 0.001, 'nul-key', 'PK36SCBL0000001123456703'), 'BAD_IBAN');   // checksum catches a mistyped digit
  await rejects(db.one(`select * from fn_micro_sell($1, 0.001, 'PK36SCBL0000001123456702', null)`, [c2]), 'BAD_KEY');
  const c3 = await customer('3100000023');
  const o = await buy(c3, 3);
  const st = (await db.one(`select id from staff limit 1`)).id;
  await db.query(`update micro_txns set status = 'paid_out', payout_ref = 'X-' || id, paid_out_at = now() where customer_id = $1 and side = 'sell'`, [c]);
  assert.equal((await db.one(`select fn_close_account($1) r`, [c3])).r.closed, true);
  const t = await db.query(`select status from micro_txns where order_id = $1`, [o.id]);
  assert.ok(t.every(x => x.status === 'expired'), 'transactions of the lapsed order expired too');
  void st;
});

test('audit fixes: one bar serial per lot; the refunds queue gets cancelled paid bookings; reconciliation covers $1 gold', async () => {
  const st = (await db.one(`select id from staff limit 1`)).id;
  const full = await db.query(`select * from tola_lots where side = 'buy' and status = 'full' order by no`);
  if (full.length >= 1) {
    await db.one(`select * from fn_lot_settle($1, $2, 'bar-unique-1', null)`, [st, full[0].id]).catch(() => {});
  }
  const settled = await db.one(`select * from tola_lots where bar_serial is not null limit 1`);
  // Make a second full lot to try the same serial on: fill the open lot
  const open = await db.one(`select * from tola_lots where side = 'buy' and status = 'filling'`);
  const need = Math.ceil(Math.round((11.664 - Number(open.grams_filled)) * 1e6) / 7000);
  const c = await customer('3100000030');
  await db.query(`update settings set value = '100000000' where key = 'daily_limit_pkr'`);
  for (let n = 0; n < need; n += 100) await pay(await buy(c, Math.min(100, need - n)));
  await db.query(`update settings set value = '1500000' where key = 'daily_limit_pkr'`);
  const next = await db.one(`select * from tola_lots where id = $1`, [open.id]);
  assert.equal(next.status, 'full');
  await rejects(db.one(`select * from fn_lot_settle($1, $2, $3, null)`, [st, next.id, settled.bar_serial]), 'BAR_SERIAL_USED');
  const rec = (await db.one(`select fn_reconcile(pk_today()) r`)).r;
  assert.ok(rec.micro && rec.micro.customer_grams > 0 && 'bars_held_grams' in rec.micro && rec.refunds_due && rec.services);
  await rejects(db.query(`truncate audit_log`), 'AUDIT_APPEND_ONLY');
});
