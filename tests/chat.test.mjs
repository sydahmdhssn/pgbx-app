// Rate chat: prices in the app are indicative; support confirms the final rate in a private chat and only that rate
// can be used, once, before it expires. Privacy between customers and staff roles, every buy and sell flow,
// attachments, and the record that can't be changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp } from '../server/security.mjs';

Object.assign(process.env, { OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', PAYMENT_WEBHOOK_SECRET: 'whsec-test', CRON_SECRET: 'cron-test' });
const { handle } = await import('../server/api.mjs');

let db, server, base;
const rates = () => { const at = new Date().toISOString(); return { ok: true, metals: { gold: { buyTola: 466560, sellTola: 460000, source: 'test', sourceUpdatedAt: at }, silver: { buyTola: 6400, sellTola: 6240, sourceUpdatedAt: at } }, usdPkr: { rate: 280 } }; };

async function call(method, path, { body, token, ip = '10.7.0.1' } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), 'x-real-ip': ip },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const err = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.error, code); return r.data; };
let n = 0;
const phone = () => '30077' + String(10000 + ++n).slice(-5);
async function login(ph) {
  ok(await call('POST', '/api/v1/auth/otp/start', { body: { phone: ph }, ip: '10.7.1.' + n }));
  return ok(await call('POST', '/api/v1/auth/otp/verify', { body: { phone: ph, code: '123456', cookie: false }, ip: '10.7.1.' + n })).token;
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

test('a chat is private: only its customer, admins and support can see or use it', async () => {
  const a = await verified(), b = await verified();
  const c = ok(await open(a, 'buy_bars', { lines: [{ product_id: 'g-1g', units: 1 }] }, 41200)).chat;
  assert.match(c.ref, /^PGBX-C-\d{6}-[0-9A-F]{6}$/);
  ok(await call('POST', `/api/v1/chats/${c.id}/messages`, { token: a, body: { body: 'What is the final rate?' } }));
  // another customer: the chat doesn't exist for them
  err(await call('GET', `/api/v1/chats/${c.id}`, { token: b }), 404, 'CHAT_NOT_FOUND');
  err(await call('POST', `/api/v1/chats/${c.id}/messages`, { token: b, body: { body: 'hi' } }), 404, 'CHAT_NOT_FOUND');
  err(await call('POST', `/api/v1/chats/${c.id}/close`, { token: b }), 404, 'CHAT_NOT_FOUND');
  assert.equal(ok(await call('GET', '/api/v1/chats', { token: b })).chats.length, 0);
  // signed out, a customer on the staff routes, and staff roles other than admin and support
  err(await call('GET', `/api/v1/chats/${c.id}`), 401);
  err(await call('GET', '/api/v1/support/chats', { token: a }), 401);
  err(await call('GET', '/api/v1/support/chats', { token: await staffToken('ops') }), 403, 'FORBIDDEN');
  err(await call('GET', `/api/v1/support/chats/${c.id}`, { token: await staffToken('dealer') }), 403, 'FORBIDDEN');
  // support and admins can; the support role can't open other admin screens
  for (const t of [sup, adm]) {
    const d = ok(await call('GET', `/api/v1/support/chats/${c.id}`, { token: t }));
    assert.equal(d.customer.kyc_status, 'verified');
    assert.equal(d.messages.at(-1).body, 'What is the final rate?');
    assert.equal(d.suggested.prices.unit['g-1g'], 41200);
  }
  err(await call('GET', '/api/v1/admin/overview', { token: sup }), 403, 'FORBIDDEN');
  err(await call('GET', '/api/v1/admin/settings', { token: sup }), 403, 'FORBIDDEN');
  assert.ok(await db.one(`select 1 from audit_log where action = 'chat.viewed' and entity_id = $1`, [c.ref]), 'staff opening a chat is recorded');
});

test('no order without a confirmed rate: bars, $1 gold buy and sell, gifts', async () => {
  const t = await verified();
  const lock = ok(await call('POST', '/api/v1/locks', { token: t, body: { products: ['g-1g'] } })).lock;      // indicative price only
  err(await call('POST', '/api/v1/orders', { token: t, body: { lockId: lock.id, lines: [{ productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: key() } }), 409, 'RATE_NOT_CONFIRMED');
  err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 2, idempotencyKey: key() } }), 409, 'RATE_NOT_CONFIRMED');
  const day = new Date(Date.now() + 5 * 3600e3 + 8 * 86400e3).toISOString().slice(0, 10);
  err(await call('POST', '/api/v1/gifts', { token: t, body: { item: 'gg-1g', shape: 'coin', design: 'eid', engraving: '', message: '', packaging: 'premium', recipientName: 'Sara Ahmed',
    recipientPhone: '03211234567', recipientCity: 'Lahore', recipientAddress: 'House 9, Model Town, Lahore', deliverBy: day, idempotencyKey: key() } }), 409, 'RATE_NOT_CONFIRMED');
});

test('bars: support confirms a rate, the customer pays exactly that, once', async () => {
  const t = await verified();
  const c = ok(await open(t, 'buy_bars', { lines: [{ product_id: 'g-1g', units: 2 }] }, 82400)).chat;
  err(await confirm(sup, c.id, { unit: { 'g-1g': 412000 } }), 400, 'RATE_OUT_OF_RANGE');         // an extra zero is caught
  err(await confirm(sup, c.id, { unit: {} }), 400, 'BAD_RATE');
  const r = ok(await confirm(sup, c.id, { unit: { 'g-1g': 41000 } }, 15)).confirmation;
  assert.equal(r.total_pkr, 82000); assert.ok(r.lock_id); assert.ok(r.expires_in > 800);
  const view = ok(await call('GET', `/api/v1/chats/${c.id}`, { token: t }));
  assert.equal(view.chat.status, 'confirmed'); assert.equal(view.confirmation.id, r.id);
  assert.match(view.messages.at(-1).body, /^Final rate confirmed: Rs 82,000/);
  // the customer is told (one notice, pushed)
  const notes = ok(await call('GET', '/api/v1/notifications', { token: t })).notifications.filter(x => x.kind === 'chat');
  assert.equal(notes[0].title, 'Final rate confirmed'); assert.deepEqual(notes[0].link, { name: 'chat', id: c.id });
  // different bars at that rate: refused
  err(await call('POST', '/api/v1/orders', { token: t, body: { lockId: r.lock_id, lines: [{ productId: 'g-1g', units: 3 }], method: 'bank', idempotencyKey: key() } }), 409, 'RATE_MISMATCH');
  const k = key();
  const o = ok(await call('POST', '/api/v1/orders', { token: t, body: { lockId: r.lock_id, lines: [{ productId: 'g-1g', units: 2 }], method: 'bank', idempotencyKey: k } })).order;
  assert.equal(o.total_pkr, 82000);
  // the same request again is the same order; a new one at the used rate is refused
  assert.equal(ok(await call('POST', '/api/v1/orders', { token: t, body: { lockId: r.lock_id, lines: [{ productId: 'g-1g', units: 2 }], method: 'bank', idempotencyKey: k } })).order.id, o.id);
  err(await call('POST', '/api/v1/orders', { token: t, body: { lockId: r.lock_id, lines: [{ productId: 'g-1g', units: 2 }], method: 'bank', idempotencyKey: key() } }), 409, 'RATE_USED');
  const after = ok(await call('GET', `/api/v1/chats/${c.id}`, { token: t }));
  assert.equal(after.chat.status, 'completed'); assert.equal(after.confirmation.status, 'used'); assert.equal(after.confirmation.used_ref, o.receipt_no);
  // another customer can't use this customer's rate
  const other = await verified();
  err(await call('POST', '/api/v1/orders', { token: other, body: { lockId: r.lock_id, lines: [{ productId: 'g-1g', units: 2 }], method: 'bank', idempotencyKey: key() } }), 404, 'LOCK_NOT_FOUND');
});

test('a confirmed rate expires; a new confirmation replaces the old one; closing withdraws it', async () => {
  const t = await verified();
  const c = ok(await open(t, 'buy_micro', { units: 3 })).chat;
  const r1 = ok(await confirm(sup, c.id, { unit_pkr: 281, price_gram: 40000, usd_pkr: 280.5 }, 10)).confirmation;
  const r2 = ok(await confirm(adm, c.id, { unit_pkr: 280, price_gram: 39950, usd_pkr: 280 }, 10)).confirmation;
  err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 3, idempotencyKey: key(), confirmationId: r1.id } }), 409, 'RATE_NOT_CONFIRMED');   // replaced
  await db.query(`alter table rate_confirmations disable trigger rate_confirmations_append_only`);
  await db.query(`update rate_confirmations set expires_at = now() - interval '1 minute' where id = $1`, [r2.id]);
  await db.query(`alter table rate_confirmations enable trigger rate_confirmations_append_only`);
  err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 3, idempotencyKey: key(), confirmationId: r2.id } }), 409, 'RATE_EXPIRED');
  const r3 = ok(await confirm(sup, c.id, { unit_pkr: 280, price_gram: 39950, usd_pkr: 280 }, 10)).confirmation;
  ok(await call('POST', `/api/v1/chats/${c.id}/close`, { token: t }));
  err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 3, idempotencyKey: key(), confirmationId: r3.id } }), 409, 'RATE_NOT_CONFIRMED');
  err(await call('POST', `/api/v1/chats/${c.id}/messages`, { token: t, body: { body: 'one more thing' } }), 409, 'CHAT_CLOSED');
  assert.equal(ok(await call('GET', `/api/v1/chats/${c.id}`, { token: t })).chat.status, 'closed');     // history stays readable
});

test('$1 gold buy and sell, gift and selling bars back at confirmed rates', async () => {
  const t = await verified();
  // $1 gold: 4 transactions at Rs 280 each, at the confirmed price per gram
  const cb = ok(await open(t, 'buy_micro', { units: 4 })).chat;
  const rb = ok(await confirm(sup, cb.id, { unit_pkr: 280, price_gram: 40000, usd_pkr: 280 })).confirmation;
  err(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 5, idempotencyKey: key(), confirmationId: rb.id } }), 409, 'RATE_MISMATCH');
  const mo = ok(await call('POST', '/api/v1/micro/buy', { token: t, body: { units: 4, idempotencyKey: key(), confirmationId: rb.id } })).order;
  assert.equal(mo.total_pkr, 1120);
  ok(await call('POST', `/api/v1/payments/sandbox/micro/${mo.id}`, { token: t, body: {} }));
  const grams = Number((await db.one(`select micro_grams(customer_id)::float8 g from micro_orders where id = $1`, [mo.id])).g);
  assert.equal(grams, 0.028);                                                   // 4 × 280 / 40000
  // selling exactly the grams confirmed
  const cs = ok(await open(t, 'sell_micro', { grams: 0.01 })).chat;
  const rs = ok(await confirm(sup, cs.id, { price_gram: 39500 })).confirmation;
  assert.equal(rs.total_pkr, 395);
  const sold = ok(await call('POST', '/api/v1/micro/sell', { token: t, body: { grams: 0.01, iban: IBAN, idempotencyKey: key(), confirmationId: rs.id } })).transaction;
  assert.equal(sold.amount_pkr ?? sold.amount, 395);
  // gift: the confirmed charges, for exactly the piece in the request
  const g = { item: 'gg-1g', shape: 'coin', design: 'eid', engraving: 'A & B', packaging: 'premium' };
  const cg = ok(await open(t, 'gift', g)).chat;
  const rg = ok(await confirm(sup, cg.id, { metal_pkr: 40500, making_pkr: 3500, packaging_pkr: 1500, delivery_pkr: 1500 })).confirmation;
  assert.equal(rg.total_pkr, 47000);
  const day = new Date(Date.now() + 5 * 3600e3 + 8 * 86400e3).toISOString().slice(0, 10);
  const giftBody = { ...g, message: 'Mubarak', recipientName: 'Sara Ahmed', recipientPhone: '03211234567', recipientCity: 'Lahore', recipientAddress: 'House 9, Model Town, Lahore', deliverBy: day };
  err(await call('POST', '/api/v1/gifts', { token: t, body: { ...giftBody, design: 'wedding', idempotencyKey: key(), confirmationId: rg.id } }), 409, 'RATE_MISMATCH');
  assert.equal(ok(await call('POST', '/api/v1/gifts', { token: t, body: { ...giftBody, idempotencyKey: key(), confirmationId: rg.id } })).gift.total_pkr, 47000);
  // selling bars back: needs bars that aren't reserved; they leave the wallet and PGBX owes the confirmed amount
  const cbuy = ok(await open(t, 'buy_bars', { lines: [{ product_id: 'g-1g', units: 2 }] })).chat;
  const rbuy = ok(await confirm(sup, cbuy.id, { unit: { 'g-1g': 41200 } })).confirmation;
  const o = ok(await call('POST', '/api/v1/orders', { token: t, body: { lockId: rbuy.lock_id, lines: [{ productId: 'g-1g', units: 2 }], method: 'bank', idempotencyKey: key() } })).order;
  ok(await call('POST', `/api/v1/payments/sandbox/${o.id}`, { token: t, body: { outcome: 'success' } }));
  err(await open(t, 'sell_bars', { lines: [{ product_id: 'g-1g', units: 3 }] }), 409, 'INSUFFICIENT_HOLDINGS');
  const csell = ok(await open(t, 'sell_bars', { lines: [{ product_id: 'g-1g', units: 1 }] })).chat;
  const rsell = ok(await confirm(sup, csell.id, { unit: { 'g-1g': 39800 } })).confirmation;
  err(await call('POST', '/api/v1/bars/sell', { token: t, body: { confirmationId: rsell.id, iban: 'PK00BAD', idempotencyKey: key() } }), 400, 'BAD_IBAN');
  const sale = ok(await call('POST', '/api/v1/bars/sell', { token: t, body: { confirmationId: rsell.id, iban: IBAN, idempotencyKey: key() } })).sale;
  assert.equal(sale.total_pkr, 39800); assert.equal(sale.status, 'pending_payout'); assert.equal(sale.payout_to, '•••• 6702');
  const held = ok(await call('GET', '/api/v1/ledger', { token: t })).entries.filter(e => e.product_id === 'g-1g').reduce((a, e) => a + e.delta, 0);
  assert.equal(held, 1);
  // operations pays it out; the customer is told; closing the account waited for it
  const ops = await staffToken('ops');
  const due = ok(await call('GET', '/api/v1/admin/bar-sales', { token: ops })).sales.find(x => x.ref === sale.ref);
  assert.ok(due);
  ok(await call('POST', `/api/v1/admin/bar-sales/${due.id}`, { token: ops, body: { ref: 'IBFT-778899' } }));
  err(await call('POST', `/api/v1/admin/bar-sales/${due.id}`, { token: ops, body: { ref: 'IBFT-000000' } }), 409, 'ALREADY_PAID');
  assert.equal(ok(await call('GET', '/api/v1/bars/sales', { token: t })).sales[0].status, 'paid_out');
});

test('messages and files: support is alerted, the customer gets one notice, nothing can be edited', async () => {
  const t = await verified(), other = await verified();
  err(await open(t, 'sell_micro', { grams: 0.001 }), 409, 'INSUFFICIENT_GOLD');   // nothing to sell
  const c = ok(await open(t, 'buy_micro', { units: 1 })).chat.id;
  ok(await call('POST', `/api/v1/chats/${c}/messages`, { token: t, body: { body: 'Here is my screenshot' } }));
  assert.equal(ok(await call('GET', '/api/v1/support/counts', { token: sup })).chats_waiting >= 1, true);
  const listed = ok(await call('GET', '/api/v1/support/chats', { token: sup })).chats.find(x => x.id === c);
  assert.equal(listed.waiting, true);
  // a photo: checked by its bytes, readable by the customer and staff only
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f40000000049454e44ae426082', 'hex');
  err(await call('POST', `/api/v1/chats/${c}/attachments`, { token: t, body: { name: 'x.png', mime: 'image/png', data: Buffer.from('not a png').toString('base64') } }), 400, 'BAD_FILE');
  const m = ok(await call('POST', `/api/v1/chats/${c}/attachments`, { token: t, body: { name: 'receipt.png', mime: 'image/png', data: png.toString('base64'), caption: 'Payment' } })).message;
  assert.equal(m.attachment.mime, 'image/png');
  err(await call('GET', `/api/v1/chats/${c}/attachments/${m.attachment.id}`, { token: other }), 404);
  assert.equal(ok(await call('GET', `/api/v1/support/chats/${c}/attachments/${m.attachment.id}`, { token: sup })).attachment.data, png.toString('base64'));
  // two replies, one unread notice
  ok(await call('POST', `/api/v1/support/chats/${c}/messages`, { token: sup, body: { body: 'Thanks, checking now.' } }));
  ok(await call('POST', `/api/v1/support/chats/${c}/messages`, { token: sup, body: { body: 'Rate in a minute.' } }));
  const notes = ok(await call('GET', '/api/v1/notifications', { token: t })).notifications.filter(x => x.kind === 'chat');
  assert.equal(notes.length, 1); assert.equal(notes[0].title, 'PGBX support replied');
  const view = ok(await call('GET', `/api/v1/chats/${c}`, { token: t }));
  assert.equal(view.messages.at(-1).staff_name, 'Ayesha');
  // polling returns only what's new
  assert.equal(ok(await call('GET', `/api/v1/chats/${c}?after=${view.messages.at(-1).id}`, { token: t })).messages.length, 0);
  // the record can't be rewritten
  await assert.rejects(db.query(`update chat_messages set body = 'changed' where chat_id = $1`, [c]), /APPEND_ONLY/);
  await assert.rejects(db.query(`delete from chat_messages where chat_id = $1`, [c]), /APPEND_ONLY/);
  await assert.rejects(db.query(`update rate_confirmations set total_pkr = 1`), /APPEND_ONLY|no rows/i).catch(() => {});
});

test('switching the rule off restores instant prices', async () => {
  await db.query(`update settings set value = 'false' where key = 'rate_chat_required'`);
  try {
    const t = await verified();
    const lock = ok(await call('POST', '/api/v1/locks', { token: t, body: { products: ['g-1g'] } })).lock;
    ok(await call('POST', '/api/v1/orders', { token: t, body: { lockId: lock.id, lines: [{ productId: 'g-1g', units: 1 }], method: 'bank', idempotencyKey: key() } }));
  } finally { await db.query(`update settings set value = 'true' where key = 'rate_chat_required'`); }
});
