-- PGBX $1 gold: customers buy gold one US dollar at a time (converted at the live USD/PKR rate) and can sell any
-- amount they hold. Every $1 purchase and every sale is a transaction with its own ID. Paid purchases from all
-- customers are clubbed, in order, into 1-tola buy lots (PGBX buys a physical tola bar for each full lot); sales are
-- clubbed the same way into 1-tola sell lots. Each lot keeps the list of transaction IDs (and the grams of each) that
-- make it up. A transaction that crosses the end of a lot is split between that lot and the next, so every full
-- lot is exactly 1 tola (11.664 g).

insert into settings (key, value) values
  ('micro_usd', '1'),                    -- US dollars per buy transaction
  ('micro_max_units', '100'),            -- most $1 transactions in one payment
  ('micro_min_sell_g', '0.001');         -- smallest sale in grams (1 mg)

-- The dollar rate used for $1 purchases is recorded with each price snapshot
alter table rate_snapshots add column usd_pkr numeric(12, 4) check (usd_pkr is null or usd_pkr > 0);

-- A payment for one or more $1 purchases
create table micro_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  customer_id uuid not null references customers(id),
  units int not null check (units between 1 and 1000),
  usd_pkr numeric(12, 4) not null,
  unit_pkr bigint not null check (unit_pkr > 0),
  total_pkr bigint not null check (total_pkr > 0),
  price_gram numeric(14, 2) not null check (price_gram > 0),   -- PGBX gold buy price per gram when ordered
  status text not null default 'pending_payment' check (status in ('pending_payment', 'credited', 'expired', 'refund_due')),
  idempotency_key text not null,
  payment_ref text,
  paid_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (customer_id, idempotency_key)
);
create index on micro_orders (customer_id, created_at);
create index on micro_orders (status) where status = 'pending_payment';

-- One transaction per $1 bought, and one per sale. ref is the transaction ID the customer and PGBX see.
create table micro_txns (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  side text not null check (side in ('buy', 'sell')),
  customer_id uuid not null references customers(id),
  order_id uuid references micro_orders(id),                    -- buys: the payment it belongs to
  amount_pkr bigint not null check (amount_pkr > 0),
  grams numeric(14, 6) not null check (grams > 0),
  price_gram numeric(14, 2) not null check (price_gram > 0),
  usd numeric(10, 2),                                           -- buys: dollars bought
  status text not null check (status in ('pending_payment', 'credited', 'expired', 'refund_due', 'pending_payout', 'paid_out')),
  payout_to text,                                               -- sells: customer's IBAN
  payout_ref text,
  paid_out_at timestamptz,
  paid_out_by text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  credited_at timestamptz,
  check (side = 'buy' and order_id is not null or side = 'sell' and payout_to is not null),
  unique (customer_id, idempotency_key)
);
create index on micro_txns (customer_id, created_at);
create index on micro_txns (order_id);
create index on micro_txns (status) where status = 'pending_payout';

-- 1-tola lots
create table tola_lots (
  id bigint generated always as identity primary key,
  side text not null check (side in ('buy', 'sell')),
  no int not null,
  ref text not null unique,                                     -- PGBX-T-000001 (buy) / PGBX-TS-000001 (sell)
  grams_target numeric(14, 6) not null default 11.664,
  grams_filled numeric(14, 6) not null default 0 check (grams_filled >= 0 and grams_filled <= grams_target),
  status text not null default 'filling' check (status in ('filling', 'full', 'settled')),
  created_at timestamptz not null default now(),
  filled_at timestamptz,
  settled_at timestamptz,
  settled_by text,
  bar_serial text,                                              -- buys: serial of the tola bar PGBX bought for this lot
  settle_note text,
  unique (side, no)
);
create unique index tola_lots_one_filling on tola_lots (side) where status = 'filling';

-- Which transactions make up each lot, and how many grams each contributed
create table lot_allocations (
  lot_id bigint not null references tola_lots(id),
  txn_id uuid not null references micro_txns(id),
  grams numeric(14, 6) not null check (grams > 0),
  primary key (lot_id, txn_id)
);
create index on lot_allocations (txn_id);

alter table micro_orders enable row level security;
alter table micro_txns enable row level security;
alter table tola_lots enable row level security;
alter table lot_allocations enable row level security;

-- ---------- helpers ----------
-- Random transaction IDs (not sequential, so they don't reveal volumes), unique by construction
create function micro_ref(p_prefix text) returns text language plpgsql as $$
declare v text;
begin
  loop
    v := p_prefix || '-' || to_char(now() at time zone 'Asia/Karachi', 'YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    exit when not exists (select 1 from micro_txns where ref = v) and not exists (select 1 from micro_orders where ref = v);
  end loop;
  return v;
end $$;

-- Grams of $1 gold a customer holds: credited buys minus sales
create function micro_grams(p_customer uuid) returns numeric language sql stable as $$
  select coalesce(sum(case when side = 'buy' then grams else -grams end), 0)
  from micro_txns where customer_id = p_customer and (side = 'buy' and status = 'credited' or side = 'sell')
$$;

-- The newest prices, if fresh enough to trade at and recorded with a dollar rate
create function micro_snapshot() returns rate_snapshots language plpgsql stable as $$
declare s rate_snapshots;
begin
  select * into s from rate_snapshots order by id desc limit 1;
  if not found or s.fetched_at < now() - make_interval(secs => setting_int('rate_stale_seconds')) or s.usd_pkr is null then perform fail('RATES_STALE'); end if;
  return s;
end $$;

-- Adds a transaction's grams to the open lot of its side, starting new lots as each one reaches 1 tola
create function allocate_to_lots(p_side text, p_txn uuid, p_grams numeric) returns void language plpgsql as $$
declare v_left numeric := p_grams; l tola_lots; v_take numeric; v_no int;
begin
  perform pg_advisory_xact_lock(hashtext('lots:' || p_side));
  while v_left > 0 loop
    select * into l from tola_lots where side = p_side and status = 'filling' for update;
    if not found then
      select coalesce(max(no), 0) + 1 into v_no from tola_lots where side = p_side;
      insert into tola_lots (side, no, ref) values (p_side, v_no, case when p_side = 'buy' then 'PGBX-T-' else 'PGBX-TS-' end || lpad(v_no::text, 6, '0'))
        returning * into l;
    end if;
    v_take := least(v_left, l.grams_target - l.grams_filled);
    insert into lot_allocations (lot_id, txn_id, grams) values (l.id, p_txn, v_take);
    update tola_lots set grams_filled = grams_filled + v_take,
        status = case when grams_filled + v_take >= grams_target then 'full' else 'filling' end,
        filled_at = case when grams_filled + v_take >= grams_target then now() end
      where id = l.id returning * into l;
    if l.status = 'full' then
      perform audit('system', 'lot.full', 'lot', l.ref, jsonb_build_object('side', p_side, 'transactions', (select count(*) from lot_allocations where lot_id = l.id)));
    end if;
    v_left := v_left - v_take;
  end loop;
end $$;

-- ---------- buying $1 at a time ----------
create function fn_micro_buy(p_customer uuid, p_units int, p_key text) returns micro_orders language plpgsql as $$
declare o micro_orders; s rate_snapshots; v_unit bigint; v_price numeric; v_grams numeric; i int;
begin
  perform require_active_customer(p_customer, true);
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));
  select * into o from micro_orders where customer_id = p_customer and idempotency_key = p_key;
  if found then return o; end if;                                  -- the same request again: same order
  if p_units is null or p_units < 1 or p_units > setting_int('micro_max_units') then perform fail('BAD_UNITS'); end if;
  s := micro_snapshot();
  v_unit := round((setting('micro_usd') #>> '{}')::numeric * s.usd_pkr);
  v_price := round(s.gold_buy_tola / 11.664, 2);
  v_grams := round(v_unit / v_price, 6);
  if spent_today(p_customer) + v_unit * p_units > setting_int('daily_limit_pkr') then perform fail('DAILY_LIMIT'); end if;
  insert into micro_orders (ref, customer_id, units, usd_pkr, unit_pkr, total_pkr, price_gram, idempotency_key)
    values (micro_ref('PGBX-MO'), p_customer, p_units, s.usd_pkr, v_unit, v_unit * p_units, v_price, p_key) returning * into o;
  for i in 1..p_units loop
    insert into micro_txns (ref, side, customer_id, order_id, amount_pkr, grams, price_gram, usd, status)
      values (micro_ref('PGBX-M'), 'buy', p_customer, o.id, v_unit, v_grams, v_price, (setting('micro_usd') #>> '{}')::numeric, 'pending_payment');
  end loop;
  perform audit('customer:' || p_customer, 'micro.ordered', 'micro', o.ref, jsonb_build_object('units', p_units, 'total', o.total_pkr, 'usd_pkr', s.usd_pkr));
  return o;
end $$;

-- Payment result for a $1 gold order. Money that can't be used (wrong amount, order lapsed or already settled) is
-- marked for refund, never credited or dropped.
create function fn_micro_paid(p_order uuid, p_ref text, p_amount bigint) returns jsonb language plpgsql as $$
declare o micro_orders; t micro_txns; v_note text; v_grams numeric;
begin
  select * into o from micro_orders where id = p_order for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if o.payment_ref is not null then return jsonb_build_object('status', o.status, 'duplicate', true); end if;
  v_note := case when o.status <> 'pending_payment' then 'Paid after the order lapsed; refund'
                 when p_amount <> o.total_pkr then 'Amount paid differs from the order total; refund'
                 when o.created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int) then 'Paid after the payment window; refund' end;
  if v_note is not null then
    update micro_orders set status = 'refund_due', payment_ref = p_ref, paid_at = now(), note = v_note where id = p_order returning * into o;
    update micro_txns set status = 'refund_due' where order_id = p_order;
    perform audit('provider', 'micro.payment_refund', 'micro', o.ref, jsonb_build_object('ref', p_ref, 'amount', p_amount, 'reason', v_note));
    perform notify_customer(o.customer_id, 'purchase', 'Payment received, gold not added', o.ref || ': we couldn’t add this gold, so your payment will be refunded.', jsonb_build_object('name', 'micro'), true);
    return jsonb_build_object('status', o.status, 'refund_due', true);
  end if;
  update micro_orders set status = 'credited', payment_ref = p_ref, paid_at = now() where id = p_order returning * into o;
  update micro_txns set status = 'credited', credited_at = now() where order_id = p_order;
  for t in select * from micro_txns where order_id = p_order order by ref loop
    perform allocate_to_lots('buy', t.id, t.grams);
  end loop;
  select sum(grams) into v_grams from micro_txns where order_id = p_order;
  perform audit('provider', 'micro.credited', 'micro', o.ref, jsonb_build_object('ref', p_ref, 'units', o.units, 'grams', v_grams));
  perform notify_customer(o.customer_id, 'purchase', 'Gold added',
    '$' || o.units || ' of gold (' || to_char(v_grams, 'FM990.0000') || ' g) for ' || rs(o.total_pkr) || ' · ' || o.ref, jsonb_build_object('name', 'micro'), false);
  return jsonb_build_object('status', o.status);
end $$;

-- ---------- selling any amount held ----------
create function fn_micro_sell(p_customer uuid, p_grams numeric, p_iban text, p_key text) returns micro_txns language plpgsql as $$
declare t micro_txns; s rate_snapshots; v_price numeric; v_grams numeric := round(p_grams, 6); v_amount bigint;
begin
  perform require_active_customer(p_customer, true);
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));    -- same lock as buying: one balance change at a time
  select * into t from micro_txns where customer_id = p_customer and idempotency_key = p_key;
  if found then return t; end if;
  if v_grams is null or v_grams < (setting('micro_min_sell_g') #>> '{}')::numeric then perform fail('BAD_GRAMS'); end if;
  if v_grams > micro_grams(p_customer) then perform fail('INSUFFICIENT_GOLD'); end if;
  if p_iban !~ '^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$' then perform fail('BAD_IBAN'); end if;
  s := micro_snapshot();
  v_price := round(s.gold_sell_tola / 11.664, 2);
  v_amount := floor(v_grams * v_price);
  if v_amount < 1 then perform fail('BAD_GRAMS'); end if;
  insert into micro_txns (ref, side, customer_id, amount_pkr, grams, price_gram, status, payout_to, idempotency_key)
    values (micro_ref('PGBX-MS'), 'sell', p_customer, v_amount, v_grams, v_price, 'pending_payout', p_iban, p_key) returning * into t;
  perform allocate_to_lots('sell', t.id, v_grams);
  perform audit('customer:' || p_customer, 'micro.sold', 'micro', t.ref, jsonb_build_object('grams', v_grams, 'amount', v_amount));
  perform notify_customer(p_customer, 'purchase', 'Gold sold',
    to_char(v_grams, 'FM990.0000') || ' g for ' || rs(v_amount) || ' · ' || t.ref || '. PGBX will pay it to your bank account ending ' || right(p_iban, 4) || '.', jsonb_build_object('name', 'micro'), false);
  return t;
end $$;

-- Operations records the bank transfer for a sale
create function fn_micro_payout(p_staff uuid, p_txn uuid, p_ref text) returns micro_txns language plpgsql as $$
declare t micro_txns;
begin
  if length(coalesce(p_ref, '')) < 4 then perform fail('BAD_REF'); end if;
  update micro_txns set status = 'paid_out', payout_ref = p_ref, paid_out_at = now(), paid_out_by = 'staff:' || p_staff
    where id = p_txn and side = 'sell' and status = 'pending_payout' returning * into t;
  if not found then perform fail('NOT_FOUND'); end if;
  perform audit('staff:' || p_staff, 'micro.paid_out', 'micro', t.ref, jsonb_build_object('payout_ref', p_ref, 'amount', t.amount_pkr));
  perform notify_customer(t.customer_id, 'purchase', 'Payment sent', rs(t.amount_pkr) || ' for ' || t.ref || ' was sent to your bank account ending ' || right(t.payout_to, 4) || '.', jsonb_build_object('name', 'micro'), true);
  return t;
end $$;

-- Operations records that the tola for a full lot was bought (buy lots, with the bar serial) or sold (sell lots)
create function fn_lot_settle(p_staff uuid, p_lot bigint, p_serial text, p_note text) returns tola_lots language plpgsql as $$
declare l tola_lots;
begin
  select * into l from tola_lots where id = p_lot for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if l.status <> 'full' then perform fail('LOT_NOT_FULL'); end if;
  if l.side = 'buy' and length(coalesce(p_serial, '')) < 3 then perform fail('SERIALS_REQUIRED'); end if;
  update tola_lots set status = 'settled', settled_at = now(), settled_by = 'staff:' || p_staff, bar_serial = nullif(p_serial, ''), settle_note = p_note
    where id = p_lot returning * into l;
  perform audit('staff:' || p_staff, 'lot.settled', 'lot', l.ref, jsonb_build_object('side', l.side, 'serial', p_serial, 'note', p_note));
  return l;
end $$;

-- Unpaid $1 gold orders lapse after the payment window
create function fn_expire_micro() returns int language plpgsql as $$
declare n int;
begin
  with e as (update micro_orders set status = 'expired' where status = 'pending_payment'
      and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int) returning id)
  update micro_txns set status = 'expired' where order_id in (select id from e) and status = 'pending_payment';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- the daily limit and account closure include $1 gold ----------
create or replace function spent_today(p_customer uuid) returns bigint language plpgsql stable as $$
declare v bigint;
begin
  select (select coalesce(sum(total_pkr), 0) from orders where customer_id = p_customer and created_at >= pk_day_start()
            and (status in ('credited', 'flagged') or (status = 'pending_payment' and created_at > now() - make_interval(mins => setting_int('order_payment_minutes')::int))))
       + (select coalesce(sum(total_pkr), 0) from gift_orders where customer_id = p_customer and created_at >= pk_day_start()
            and (status in ('placed', 'in_production', 'dispatched', 'delivered') or (status = 'pending_payment' and created_at > now() - make_interval(mins => setting_int('order_payment_minutes')::int))))
       + (select coalesce(sum(total_pkr), 0) from micro_orders where customer_id = p_customer and created_at >= pk_day_start()
            and (status = 'credited' or (status = 'pending_payment' and created_at > now() - make_interval(mins => setting_int('order_payment_minutes')::int))))
  into v;
  return v;
end $$;

create or replace function fn_close_account(p_customer uuid) returns jsonb language plpgsql as $$
declare v_blockers jsonb := '[]'; v_units int; v_active int; v_flagged int; v_services int; v_days bigint; v_grams numeric; v_payouts int;
begin
  perform require_active_customer(p_customer, false);
  select coalesce(sum(units), 0) into v_units from v_holdings where customer_id = p_customer;
  select count(*) into v_active from redemptions where customer_id = p_customer and status in ('requested', 'ready') and expires_at > now();
  select count(*) into v_flagged from orders where customer_id = p_customer and status in ('flagged', 'pending_payment');
  select (select count(*) from appraisals where customer_id = p_customer and status in ('booked', 'confirmed'))
       + (select count(*) from gift_orders where customer_id = p_customer and status in ('placed', 'in_production', 'dispatched')) into v_services;
  v_grams := micro_grams(p_customer);
  select count(*) into v_payouts from micro_txns where customer_id = p_customer and status = 'pending_payout';
  if v_units > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'HOLDINGS', 'units', v_units); end if;
  if v_active > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'ACTIVE_REDEMPTIONS', 'count', v_active); end if;
  if v_flagged > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'OPEN_ORDERS', 'count', v_flagged); end if;
  if v_services > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'OPEN_SERVICES', 'count', v_services); end if;
  if v_grams > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'GOLD_SAVINGS', 'grams', v_grams); end if;
  if v_payouts > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'PAYOUTS_PENDING', 'count', v_payouts); end if;
  if jsonb_array_length(v_blockers) > 0 then return jsonb_build_object('closed', false, 'blockers', v_blockers); end if;
  v_days := setting_int('retention_days');
  update customers set status = 'closed', closed_at = now(), closed_phone = phone, phone = null,
    purge_after = case when v_days is null then null else now() + make_interval(days => v_days::int) end
  where id = p_customer;
  update sessions set revoked_at = now() where customer_id = p_customer and revoked_at is null;
  delete from push_tokens where customer_id = p_customer;
  update price_alerts set active = false where customer_id = p_customer;
  update appraisals set status = 'cancelled', updated_at = now() where customer_id = p_customer and status = 'pending_payment';
  update gift_orders set status = 'cancelled', updated_at = now() where customer_id = p_customer and status = 'pending_payment';
  update micro_orders set status = 'expired' where customer_id = p_customer and status = 'pending_payment';
  perform audit('customer:' || p_customer, 'account.closed', 'customer', p_customer::text, '{}');
  return jsonb_build_object('closed', true, 'blockers', '[]'::jsonb);
end $$;

-- Purge removes the bank account numbers of closed customers' sales once paid; amounts and IDs stay for the records
create or replace function fn_purge_closed() returns int language plpgsql as $$
declare n int;
begin
  with p as (
    update customers set name = null, cnic = null, dob = null, email = null, address = null, closed_phone = null, purged_at = now()
    where status = 'closed' and purge_after is not null and purge_after < now() and purged_at is null returning id
  ), d as (delete from notifications where customer_id in (select id from p)
  ), r as (delete from support_requests where customer_id in (select id from p)
  ), a as (update appraisals set address = '[removed]', area = '[removed]', phone = '[removed]', notes = null, visit_code = '0000' where customer_id in (select id from p)
  ), g as (update gift_orders set recipient_name = '[removed]', recipient_phone = '[removed]', recipient_address = '[removed]', message = null, engraving = null
     where customer_id in (select id from p)
  ), m as (update micro_txns set payout_to = 'PK00REMOVED0000000000000' where customer_id in (select id from p) and status = 'paid_out')
  select count(*) into n from p;
  if n > 0 then perform audit('system', 'customers.purged', 'customer', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;

-- Same lock-down as the other migrations
revoke execute on all functions in schema public from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
    end if;
  end loop;
end $$;
