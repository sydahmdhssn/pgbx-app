// Services rules in the database: doorstep appraisal and gift bullion. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../server/memory-db.mjs';

let db;
const rejects = async (p, code) => assert.rejects(p, e => e.message.includes(code), `expected ${code}`);
const customer = async (phone, kyc = 'verified') => (await db.one(`insert into customers (phone, name, cnic, kyc_status) values ($1, 'Test', '42101-' || right($1, 7) || '-1', $2) returning id`, [phone, kyc])).id;
const staff = async () => (await db.one(`insert into staff (email, name, role, password_hash, totp_secret) values ($1, 'Ops', 'ops', 'x', 'x') returning id`, ['ops' + Math.random() + '@t.pk'])).id;
const items = JSON.stringify([{ metal: 'gold', karat: '22K', approx_g: 20 }]);
const day = n => new Date(Date.now() + 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);   // Pakistan dates (UTC+5), like the server
const book = (c, over = {}) => db.one(`select * from fn_book_appraisal($1, $2, $3, $4, $5, $6::date, $7, $8::jsonb, $9, $10)`,
  [c, over.city || 'Karachi', 'Clifton', over.address || 'House 12, Street 4, Block 5', '3001234567', over.date || day(3), over.slot || '10:00-12:00', over.items || items, '', '4821']);
const gift = (c, over = {}) => db.one(`select * from fn_place_gift($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date)`,
  [c, over.item || 'gg-1g', over.shape || 'coin', over.design || 'eid', over.engraving ?? 'Eid Mubarak Ammi', 'With love', over.packaging || 'premium',
    'Ayesha Khan', '3009876543', over.city || 'Lahore', 'House 7, Gulberg III, Lahore', over.date || day(7)]);

before(async () => { db = await createMemoryDb(); await db.one(`select fn_record_rates(466560, 460000, 6400, 6240, 'test') as id`); });
after(async () => db.close());

test('appraisal booking checks city, slot, date, items and address', async () => {
  const c = await customer('3100000001', 'none');                       // no identity check needed to book a visit
  await rejects(book(c, { city: 'Gilgit' }), 'CITY_NOT_SERVED');
  await rejects(book(c, { slot: '23:00-01:00' }), 'BAD_SLOT');
  await rejects(book(c, { date: day(0) }), 'BAD_DATE');
  await rejects(book(c, { date: day(40) }), 'BAD_DATE');
  await rejects(book(c, { items: '[]' }), 'NO_ITEMS');
  await rejects(book(c, { address: 'short' }), 'BAD_ADDRESS');
  const a = await book(c);
  assert.equal(a.status, 'pending_payment'); assert.equal(a.fee_pkr, 2500); assert.match(a.ref, /^PGBX-A-/);
});

test('appraisal is paid once, assigned, completed and notified', async () => {
  const c = await customer('3100000002'); const s = await staff();
  const wrong = await book(c, { date: day(4) });                           // a wrong amount is kept and marked for refund, never lost
  const w = (await db.one(`select fn_service_paid('appraisal', $1, 'r0', 100) r`, [wrong.id])).r;
  assert.equal(w.refund_due, true);
  assert.equal((await db.one(`select payment_ref, status from appraisals where id = $1`, [wrong.id])).payment_ref, 'r0');
  const a = await book(c);
  assert.equal((await db.one(`select fn_service_paid('appraisal', $1, 'r1', 2500) r`, [a.id])).r.status, 'booked');
  assert.equal((await db.one(`select fn_service_paid('appraisal', $1, 'r1', 2500) r`, [a.id])).r.duplicate, true);
  await rejects(db.one(`select * from fn_appraisal_update($1, $2, 'complete', '{}')`, [s, a.id]), 'BAD_ACTION');   // not yet confirmed
  await rejects(db.one(`select * from fn_appraisal_update($1, $2, 'assign', '{"name":"A"}')`, [s, a.id]), 'BAD_GOLDSMITH');
  const conf = await db.one(`select * from fn_appraisal_update($1, $2, 'assign', '{"name":"Usman Zargar","phone":"03001112223"}')`, [s, a.id]);
  assert.equal(conf.status, 'confirmed');
  const done = await db.one(`select * from fn_appraisal_update($1, $2, 'complete', '{"summary":"22K confirmed, 19.6 g net"}')`, [s, a.id]);
  assert.equal(done.status, 'completed');
  const n = await db.query(`select title from notifications where customer_id = $1 order by created_at`, [c]);
  assert.deepEqual(n.map(x => x.title), ['Payment received, booking not confirmed', 'Appraisal booked', 'Appraisal confirmed', 'Appraisal report ready']);
});

test('appraisal cancellation: refund only when paid and early enough', async () => {
  const c = await customer('3100000003');
  const late = await book(c, { date: day(1), slot: '10:00-12:00' });
  await db.one(`select fn_service_paid('appraisal', $1, 'r2', 2500) r`, [late.id]);
  await db.query(`update appraisals set visit_date = pk_today() + 1, slot = '10:00-12:00' where id = $1`, [late.id]);
  const early = await book(c, { date: day(5) });
  await db.one(`select fn_service_paid('appraisal', $1, 'r3', 2500) r`, [early.id]);
  assert.equal((await db.one(`select * from fn_cancel_appraisal($1, $2)`, [c, early.id])).refund_due, true);
  await rejects(db.one(`select * from fn_cancel_appraisal($1, $2)`, [c, early.id]), 'CANNOT_CANCEL');
  // Tomorrow 10:00 is between 10 and 34 hours away depending on the time now, so use a 48-hour window for this check
  await db.query(`update settings set value = '48' where key = 'appraisal_free_cancel_hours'`);
  assert.equal((await db.one(`select * from fn_cancel_appraisal($1, $2)`, [c, late.id])).refund_due, false);   // inside the window: no refund
  await db.query(`update settings set value = '24' where key = 'appraisal_free_cancel_hours'`);
  const other = await customer('3100000004');
  await rejects(db.one(`select * from fn_cancel_appraisal($1, $2)`, [other, early.id]), 'NOT_FOUND');  // only your own
});

test('a slot holds at most six paid visits', async () => {
  const c = await customer('3100000005');
  for (let i = 0; i < 6; i++) { const a = await book(c, { date: day(9), slot: '18:00-20:00' }); await db.one(`select fn_service_paid('appraisal', $1, $2, 2500) r`, [a.id, 'slot' + i]); }
  await rejects(book(c, { date: day(9), slot: '18:00-20:00' }), 'SLOT_FULL');
});

test('gift price is metal at the buy rate + making + packaging + delivery, from fresh prices only', async () => {
  const q = (await db.one(`select fn_gift_quote('gg-1g', 'coin', 'eid', 'Eid Mubarak', 'premium') q`)).q;
  assert.equal(q.metal_pkr, 40000);                                     // 466,560 per tola = 40,000 per gram
  assert.equal(q.making_pkr, 2500 + 1000); assert.equal(q.packaging_pkr, 1500); assert.equal(q.delivery_pkr, 1500);
  assert.equal(q.total_pkr, 40000 + 3500 + 1500 + 1500);
  const plain = (await db.one(`select fn_gift_quote('gs-1t', 'bar', 'plain', '', 'standard') q`)).q;
  assert.equal(plain.total_pkr, 6400 + 1500 + 0 + 1500);
  await rejects(db.one(`select fn_gift_quote('gg-10g', 'coin', 'plain', '', 'standard') q`), 'BAD_SHAPE');
  await rejects(db.one(`select fn_gift_quote('gg-1g', 'coin', 'plain', 'This engraving is far too long', 'standard') q`), 'ENGRAVING_TOO_LONG');
  await db.query(`update rate_snapshots set fetched_at = now() - interval '10 minutes'`);
  await rejects(db.one(`select fn_gift_quote('gg-1g', 'coin', 'plain', '', 'standard') q`), 'RATES_STALE');
  await db.one(`select fn_record_rates(466560, 460000, 6400, 6240, 'test') as id`);
});

test('gift orders need verified identity, a served city, lead time and the daily limit', async () => {
  await rejects(gift(await customer('3100000006', 'none')), 'KYC_REQUIRED');
  const c = await customer('3100000007');
  await rejects(gift(c, { city: 'Atlantis' }), 'CITY_NOT_SERVED');
  await rejects(gift(c, { date: day(2) }), 'BAD_DATE');
  const g = await gift(c);
  assert.equal(g.status, 'pending_payment'); assert.equal(g.total_pkr, 46500); assert.match(g.ref, /^PGBX-G-/);
  await rejects(gift(c, { item: 'gg-10g', shape: 'bar' }).then(() => gift(c, { item: 'gg-10g', shape: 'bar' })).then(() => gift(c, { item: 'gg-10g', shape: 'bar' })).then(() => gift(c, { item: 'gg-10g', shape: 'bar' })), 'DAILY_LIMIT');
});

test('gift order lifecycle: paid, made, dispatched with tracking, delivered; cancel only before production', async () => {
  const c = await customer('3100000008'); const s = await staff();
  const g = await gift(c);
  assert.equal((await db.one(`select fn_service_paid('gift', $1, 'gr1', $2) r`, [g.id, g.total_pkr])).r.status, 'placed');
  const g2 = await gift(c, { item: 'gs-1t', shape: 'bar', design: 'plain', engraving: '' });
  await db.one(`select fn_service_paid('gift', $1, 'gr2', $2) r`, [g2.id, g2.total_pkr]);
  assert.equal((await db.one(`select * from fn_cancel_gift($1, $2)`, [c, g2.id])).refund_due, true);
  await db.one(`select * from fn_gift_update($1, $2, 'produce', '{}')`, [s, g.id]);
  await rejects(db.one(`select * from fn_cancel_gift($1, $2)`, [c, g.id]), 'CANNOT_CANCEL');
  await rejects(db.one(`select * from fn_gift_update($1, $2, 'dispatch', '{}')`, [s, g.id]), 'TRACKING_REQUIRED');
  await db.one(`select * from fn_gift_update($1, $2, 'dispatch', '{"tracking":"TCS123456"}')`, [s, g.id]);
  const done = await db.one(`select * from fn_gift_update($1, $2, 'deliver', '{}')`, [s, g.id]);
  assert.equal(done.status, 'delivered'); assert.equal(done.tracking, 'TCS123456');
  await rejects(db.one(`select * from fn_gift_update($1, $2, 'deliver', '{}')`, [s, g.id]), 'BAD_ACTION');
});

test('open services block account closure; purge removes addresses', async () => {
  const c = await customer('3100000009', 'none');
  const a = await book(c);
  await db.one(`select fn_service_paid('appraisal', $1, 'cl', 2500) r`, [a.id]);
  const r = (await db.one(`select fn_close_account($1) r`, [c])).r;
  assert.equal(r.closed, false); assert.equal(r.blockers[0].code, 'OPEN_SERVICES');
  await db.one(`select * from fn_cancel_appraisal($1, $2)`, [c, a.id]);
  assert.equal((await db.one(`select fn_close_account($1) r`, [c])).r.closed, true);
  await db.query(`update customers set closed_at = now() - interval '40 days' where id = $1`, [c]);
  assert.equal((await db.one(`select fn_purge_closed() n`)).n, 0);          // no retention period set yet: nothing purged
  await db.query(`update settings set value = '30' where key = 'retention_days'`);
  await db.one(`select fn_purge_closed() n`);
  await db.query(`update settings set value = 'null' where key = 'retention_days'`);
  assert.equal((await db.one(`select address from appraisals where id = $1`, [a.id])).address, '[removed]');
});

test('unpaid bookings lapse', async () => {
  const c = await customer('3100000010');
  const a = await book(c);
  await db.query(`update appraisals set created_at = now() - interval '2 hours' where id = $1`, [a.id]);
  assert.ok((await db.one(`select fn_expire_services() n`)).n >= 1);
  assert.equal((await db.one(`select status from appraisals where id = $1`, [a.id])).status, 'cancelled');
});

test('payments after cancellation or the payment window are kept for refund', async () => {
  const c = await customer('3100000020');
  const a = await book(c, { date: day(6) });
  await db.one(`select * from fn_cancel_appraisal($1, $2)`, [c, a.id]);
  const r = (await db.one(`select fn_service_paid('appraisal', $1, 'late1', 2500) r`, [a.id])).r;
  assert.equal(r.refund_due, true);
  const g = await gift(c);
  await db.query(`update gift_orders set created_at = now() - interval '2 hours' where id = $1`, [g.id]);
  assert.equal((await db.one(`select fn_service_paid('gift', $1, 'late2', $2) r`, [g.id, g.total_pkr])).r.refund_due, true);
});

test('unpaid bookings hold their slot while payable, so a slot can’t be overbooked', async () => {
  const c = await customer('3100000021');
  for (let i = 0; i < 6; i++) await book(c, { date: day(11), slot: '12:00-14:00' });
  await rejects(book(c, { date: day(11), slot: '12:00-14:00' }), 'SLOT_FULL');
});

test('gift orders and purchases share one daily limit', async () => {
  const c = await customer('3100000022');
  await db.query(`update settings set value = '100000' where key = 'daily_limit_pkr'`);
  await gift(c);                                                             // 46,500
  const l = await db.one(`select * from fn_create_lock($1, $2)`, [c, ['g-1g']]);
  await rejects(db.one(`select * from fn_place_order($1, $2, $3::jsonb, 'bank', 'lim1')`, [c, l.id, JSON.stringify([{ product_id: 'g-1g', units: 2 }])]), 'DAILY_LIMIT');
  await db.query(`update settings set value = '1500000' where key = 'daily_limit_pkr'`);
});

test('the public Supabase roles can read nothing, views included', async () => {
  for (const q of ['create role anon', 'grant usage on schema public to anon', 'grant select on all tables in schema public to anon']) await db.query(q);   // as Supabase's defaults would
  const c = await customer('3100000023');
  await db.query(`insert into ledger (customer_id, product_id, delta, reason, ref, created_by) values ($1, 'g-1g', 1, 'purchase', 'x', 'test')`, [c]);
  await db.query(`set role anon`);
  try {
    assert.equal((await db.query(`select * from ledger`)).length, 0);
    assert.equal((await db.query(`select * from v_holdings`)).length, 0);           // views follow row-level security
    await rejects(db.query(`select fn_close_account($1)`, [c]), 'permission denied');  // functions aren't callable
  } finally { await db.query(`reset role`); }
});
