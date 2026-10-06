-- Fixes from the 7 October 2026 audit: payments and refunds for every product, closing races, $1 gold integrity,
-- reconciliation coverage, retention, performance and hardening.

-- =====================================================================
-- 1. Every payment for $1 gold and services is recorded once (provider + reference), so a second, different payment
--    is never mistaken for a repeat of the first. Refunds owed for any product have one queue with a paid state.
-- =====================================================================
create table service_payments (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('micro', 'appraisal', 'gift')),
  entity_id uuid not null,
  provider text not null,
  provider_ref text not null,
  amount_pkr bigint not null check (amount_pkr > 0),
  created_at timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index on service_payments (kind, entity_id);
create index on service_payments (created_at);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('order', 'micro', 'appraisal', 'gift')),
  entity_id uuid not null,
  entity_ref text,
  customer_id uuid references customers(id),
  provider text,
  payment_ref text,
  amount_pkr bigint not null check (amount_pkr >= 0),
  reason text not null,
  status text not null default 'due' check (status in ('due', 'refunded')),
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  refund_ref text,
  refunded_by text,
  unique (kind, entity_id, payment_ref)
);
create index on refunds (status, created_at);
alter table service_payments enable row level security;
alter table refunds enable row level security;

create function record_refund(p_kind text, p_entity uuid, p_ref text, p_customer uuid, p_provider text, p_payment_ref text, p_amount bigint, p_reason text)
returns void language sql as $$
  insert into refunds (kind, entity_id, entity_ref, customer_id, provider, payment_ref, amount_pkr, reason)
  values (p_kind, p_entity, p_ref, p_customer, p_provider, p_payment_ref, coalesce(p_amount, 0), p_reason)
  on conflict (kind, entity_id, payment_ref) do nothing
$$;

alter table micro_orders drop constraint micro_orders_status_check;
alter table micro_orders add constraint micro_orders_status_check check (status in ('pending_payment', 'credited', 'expired', 'refund_due', 'refunded'));
alter table micro_orders add column provider text;
alter table appraisals add column refunded_at timestamptz;
alter table gift_orders add column refunded_at timestamptz;

-- Any booking or gift that becomes "refund due" (customer or operations cancelling a paid one, or a payment that
-- can't be used) goes into the refunds queue.
create function trg_service_refund() returns trigger language plpgsql as $$
begin
  if new.refund_due and not old.refund_due then
    perform record_refund(case when tg_table_name = 'appraisals' then 'appraisal' else 'gift' end, new.id, new.ref, new.customer_id,
      (select provider from service_payments where provider_ref = new.payment_ref limit 1), new.payment_ref,
      case when tg_table_name = 'appraisals' then (to_jsonb(new) ->> 'fee_pkr')::bigint else (to_jsonb(new) ->> 'total_pkr')::bigint end,
      coalesce(new.note, 'Cancelled after payment'));
  end if;
  return new;
end $$;
create trigger appraisals_refund after update of refund_due on appraisals for each row execute function trg_service_refund();
create trigger gift_orders_refund after update of refund_due on gift_orders for each row execute function trg_service_refund();

-- Operations records that a refund was paid (with the bank or provider reference)
create function fn_mark_refunded(p_staff uuid, p_refund uuid, p_ref text) returns refunds language plpgsql as $$
declare r refunds;
begin
  if length(coalesce(trim(p_ref), '')) < 4 then perform fail('BAD_REF'); end if;
  update refunds set status = 'refunded', refunded_at = now(), refund_ref = trim(p_ref), refunded_by = 'staff:' || p_staff
    where id = p_refund and status = 'due' returning * into r;
  if not found then perform fail('NOT_FOUND'); end if;
  if r.kind = 'micro' then update micro_orders set status = 'refunded' where id = r.entity_id and status = 'refund_due' and payment_ref is not distinct from r.payment_ref;
  elsif r.kind = 'appraisal' then update appraisals set refunded_at = now() where id = r.entity_id and payment_ref is not distinct from r.payment_ref;
  elsif r.kind = 'gift' then update gift_orders set refunded_at = now() where id = r.entity_id and payment_ref is not distinct from r.payment_ref;
  end if;
  perform audit('staff:' || p_staff, 'refund.paid', r.kind, coalesce(r.entity_ref, r.entity_id::text), jsonb_build_object('refund', r.id, 'ref', p_ref, 'amount', r.amount_pkr));
  if r.customer_id is not null then
    perform notify_customer(r.customer_id, 'account', 'Refund sent', rs(r.amount_pkr) || ' for ' || coalesce(r.entity_ref, 'your payment') || ' was refunded.', null, true);
  end if;
  return r;
end $$;

-- =====================================================================
-- 2. Closing an account and buying/paying can't interleave: everything that changes a customer's money takes a
--    share lock on the customer row first; closing takes an exclusive lock on it.
-- =====================================================================
create or replace function require_active_customer(p_customer uuid, p_need_kyc boolean) returns customers language plpgsql as $$
declare c customers;
begin
  select * into c from customers where id = p_customer for share;
  if not found or c.status <> 'active' then perform fail('ACCOUNT_INACTIVE'); end if;
  if p_need_kyc and c.kyc_status <> 'verified' then perform fail('KYC_REQUIRED'); end if;
  return c;
end $$;

-- Orders: the same rules as before, plus: a missing amount is refused, a payment for an account that is no longer
-- active is held for operations, and a second payment for a settled order goes into the refunds queue.
create or replace function fn_payment_succeeded(p_provider text, p_ref text, p_order uuid, p_amount bigint, p_data jsonb default '{}')
returns orders language plpgsql as $$
declare v_order orders; v_new boolean; v_cid uuid; v_cstatus text;
begin
  if p_amount is null or p_amount <= 0 then perform fail('BAD_AMOUNT'); end if;
  if coalesce(p_ref, '') = '' then perform fail('BAD_EVENT'); end if;
  select customer_id into v_cid from orders where id = p_order;
  if not found then perform fail('ORDER_NOT_FOUND'); end if;
  select status into v_cstatus from customers where id = v_cid for share;      -- lock order: customer, then order
  select * into v_order from orders where id = p_order for update;
  insert into payments (order_id, provider, provider_ref, amount_pkr, status, data)
  values (p_order, p_provider, p_ref, p_amount, 'succeeded', coalesce(p_data, '{}'))
  on conflict (provider, provider_ref) do nothing;
  get diagnostics v_new = row_count;
  if v_new and v_order.status = 'pending_payment' and v_order.created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int) then
    update orders set status = 'flagged', paid_at = now(), note = 'Paid after the payment window; refund or re-price' where id = p_order returning * into v_order;
    perform audit('provider:' || p_provider, 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'late_payment'));
    return v_order;
  end if;
  if not v_new or v_order.status <> 'pending_payment' then
    if v_new and v_order.status in ('credited', 'flagged', 'refunded') then   -- a second payment for the same order: refund it
      perform audit('provider:' || p_provider, 'order.extra_payment', 'order', p_order::text, jsonb_build_object('ref', p_ref, 'amount', p_amount));
      perform record_refund('order', p_order, v_order.receipt_no, v_order.customer_id, p_provider, p_ref, p_amount, 'Second payment for an order already paid');
    end if;
    if v_new and v_order.status in ('expired', 'failed') then
      update orders set status = 'flagged', paid_at = now(), note = 'Paid after the order lapsed; refund or credit' where id = p_order returning * into v_order;
      perform audit('provider:' || p_provider, 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'late_payment'));
    end if;
    return v_order;
  end if;
  update orders set paid_at = now() where id = p_order;
  if v_cstatus is distinct from 'active' then
    update orders set status = 'flagged', note = 'Paid while the account is not active; refund' where id = p_order returning * into v_order;
    perform audit('provider:' || p_provider, 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'account_inactive'));
    return v_order;
  end if;
  if p_amount <> v_order.total_pkr then
    update orders set status = 'flagged', note = 'Amount paid differs from the order total' where id = p_order returning * into v_order;
    perform audit('provider:' || p_provider, 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'amount_mismatch', 'paid', p_amount));
    perform notify_customer(v_order.customer_id, 'purchase', 'Payment received, order being completed',
      v_order.receipt_no || '. PGBX operations is completing your order.', jsonb_build_object('name', 'receipt', 'oid', v_order.id), false);
    return v_order;
  end if;
  begin
    perform credit_order(v_order, 'provider:' || p_provider);
  exception when others then
    update orders set status = 'flagged', note = 'Crediting failed: ' || sqlerrm where id = p_order;
    perform audit('system', 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'credit_failed', 'error', sqlerrm));
    select * into v_order from orders where id = p_order;
    return v_order;
  end;
  select * into v_order from orders where id = p_order;
  perform audit('provider:' || p_provider, 'order.credited', 'order', p_order::text, jsonb_build_object('payment', p_ref));
  perform notify_customer(v_order.customer_id, 'purchase', 'Purchase confirmed', v_order.receipt_no || ' · ' || rs(v_order.total_pkr),
    jsonb_build_object('name', 'receipt', 'oid', v_order.id), false);
  return v_order;
end $$;

-- $1 gold payments
drop function fn_micro_paid(uuid, text, bigint);
create function fn_micro_paid(p_order uuid, p_ref text, p_amount bigint, p_provider text default 'provider') returns jsonb language plpgsql as $$
declare o micro_orders; t micro_txns; v_note text; v_grams numeric; v_new int; v_cid uuid; v_cstatus text;
begin
  if p_amount is null or p_amount <= 0 then perform fail('BAD_AMOUNT'); end if;
  if coalesce(p_ref, '') = '' then perform fail('BAD_EVENT'); end if;
  select customer_id into v_cid from micro_orders where id = p_order;
  if not found then perform fail('NOT_FOUND'); end if;
  select status into v_cstatus from customers where id = v_cid for share;
  select * into o from micro_orders where id = p_order for update;
  insert into service_payments (kind, entity_id, provider, provider_ref, amount_pkr) values ('micro', o.id, p_provider, p_ref, p_amount)
    on conflict (provider, provider_ref) do nothing;
  get diagnostics v_new = row_count;
  if v_new = 0 then return jsonb_build_object('status', o.status, 'duplicate', true); end if;   -- the same provider event again
  v_note := case when o.payment_ref is not null then 'Second payment for an order already paid; refund'
                 when o.status <> 'pending_payment' then 'Paid after the order lapsed; refund'
                 when p_amount <> o.total_pkr then 'Amount paid differs from the order total; refund'
                 when o.created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int) then 'Paid after the payment window; refund'
                 when v_cstatus is distinct from 'active' then 'Paid while the account is not active; refund' end;
  if v_note is not null then
    if o.payment_ref is null then
      update micro_orders set status = 'refund_due', payment_ref = p_ref, paid_at = now(), note = v_note, provider = p_provider where id = p_order returning * into o;
      update micro_txns set status = 'refund_due' where order_id = p_order and status in ('pending_payment', 'expired');
    end if;
    perform record_refund('micro', o.id, o.ref, o.customer_id, p_provider, p_ref, p_amount, v_note);
    perform audit('provider:' || p_provider, 'micro.payment_refund', 'micro', o.ref, jsonb_build_object('ref', p_ref, 'amount', p_amount, 'reason', v_note));
    perform notify_customer(o.customer_id, 'purchase', 'Payment received, gold not added', o.ref || ': we couldn’t add gold for this payment, so it will be refunded.', jsonb_build_object('name', 'micro'), true);
    return jsonb_build_object('status', o.status, 'refund_due', true);
  end if;
  update micro_orders set status = 'credited', payment_ref = p_ref, paid_at = now(), provider = p_provider where id = p_order returning * into o;
  update micro_txns set status = 'credited', credited_at = now() where order_id = p_order;
  for t in select * from micro_txns where order_id = p_order order by ref loop
    perform allocate_to_lots('buy', t.id, t.grams);
  end loop;
  select sum(grams) into v_grams from micro_txns where order_id = p_order;
  perform audit('provider:' || p_provider, 'micro.credited', 'micro', o.ref, jsonb_build_object('ref', p_ref, 'units', o.units, 'grams', v_grams));
  perform notify_customer(o.customer_id, 'purchase', 'Gold added',
    '$' || o.units || ' of gold (' || to_char(v_grams, 'FM990.0000') || ' g) for ' || rs(o.total_pkr) || ' · ' || o.ref, jsonb_build_object('name', 'micro'), false);
  return jsonb_build_object('status', o.status);
end $$;

-- Appraisal and gift payments: same pattern
drop function fn_service_paid(text, uuid, text, bigint);
create function fn_service_paid(p_kind text, p_id uuid, p_ref text, p_amount bigint, p_provider text default 'provider') returns jsonb language plpgsql as $$
declare a appraisals; g gift_orders; v_note text; v_new int; v_cid uuid; v_cstatus text;
begin
  if p_amount is null or p_amount <= 0 then perform fail('BAD_AMOUNT'); end if;
  if coalesce(p_ref, '') = '' then perform fail('BAD_EVENT'); end if;
  if p_kind not in ('appraisal', 'gift') then perform fail('BAD_ACTION'); end if;
  if p_kind = 'appraisal' then select customer_id into v_cid from appraisals where id = p_id; else select customer_id into v_cid from gift_orders where id = p_id; end if;
  if v_cid is null then perform fail('NOT_FOUND'); end if;
  select status into v_cstatus from customers where id = v_cid for share;
  insert into service_payments (kind, entity_id, provider, provider_ref, amount_pkr) values (p_kind, p_id, p_provider, p_ref, p_amount)
    on conflict (provider, provider_ref) do nothing;
  get diagnostics v_new = row_count;
  if p_kind = 'appraisal' then
    select * into a from appraisals where id = p_id for update;
    if v_new = 0 then return jsonb_build_object('status', a.status, 'duplicate', true); end if;
    if a.payment_ref is not null then                              -- a second, different payment for a paid booking
      perform record_refund('appraisal', a.id, a.ref, a.customer_id, p_provider, p_ref, p_amount, 'Second payment for a booking already paid');
      perform audit('provider:' || p_provider, 'appraisal.extra_payment', 'appraisal', p_id::text, jsonb_build_object('ref', p_ref, 'amount', p_amount));
      return jsonb_build_object('status', a.status, 'refund_due', true);
    end if;
    perform pg_advisory_xact_lock(hashtext('slot:' || a.visit_date || a.slot));
    v_note := case when a.status <> 'pending_payment' then 'Paid after the booking was cancelled; refund'
                   when p_amount <> a.fee_pkr then 'Amount paid differs from the fee; refund'
                   when (select count(*) from appraisals where visit_date = a.visit_date and slot = a.slot and status in ('booked', 'confirmed')) >= 6 then 'Slot filled before payment; refund or rebook'
                   when a.created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int) then 'Paid after the payment window; refund or rebook'
                   when v_cstatus is distinct from 'active' then 'Paid while the account is not active; refund' end;
    if v_note is not null then
      update appraisals set payment_ref = p_ref, paid_at = now(), refund_due = true, note = v_note, status = 'cancelled', updated_at = now() where id = p_id returning * into a;
      perform audit('provider:' || p_provider, 'appraisal.payment_refund', 'appraisal', p_id::text, jsonb_build_object('ref', p_ref, 'amount', p_amount, 'reason', v_note));
      perform notify_customer(a.customer_id, 'service', 'Payment received, booking not confirmed', a.ref || ': we couldn’t confirm this visit, so your payment will be refunded.', jsonb_build_object('name', 'appraisal', 'id', a.id), true);
      return jsonb_build_object('status', a.status, 'refund_due', true);
    end if;
    update appraisals set status = 'booked', payment_ref = p_ref, paid_at = now(), updated_at = now() where id = p_id returning * into a;
    perform notify_customer(a.customer_id, 'service', 'Appraisal booked',
      a.ref || ' · ' || to_char(a.visit_date, 'DD Mon') || ', ' || a.slot || '. We’ll confirm your goldsmith before the visit.', jsonb_build_object('name', 'appraisal', 'id', a.id), false);
    perform audit('provider:' || p_provider, 'appraisal.paid', 'appraisal', p_id::text, jsonb_build_object('ref', p_ref));
    return jsonb_build_object('status', a.status);
  end if;
  select * into g from gift_orders where id = p_id for update;
  if v_new = 0 then return jsonb_build_object('status', g.status, 'duplicate', true); end if;
  if g.payment_ref is not null then
    perform record_refund('gift', g.id, g.ref, g.customer_id, p_provider, p_ref, p_amount, 'Second payment for an order already paid');
    perform audit('provider:' || p_provider, 'gift.extra_payment', 'gift', p_id::text, jsonb_build_object('ref', p_ref, 'amount', p_amount));
    return jsonb_build_object('status', g.status, 'refund_due', true);
  end if;
  v_note := case when g.status <> 'pending_payment' then 'Paid after the order was cancelled; refund'
                 when p_amount <> g.total_pkr then 'Amount paid differs from the order total; refund'
                 when g.created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int) then 'Paid after the payment window; refund or re-price'
                 when v_cstatus is distinct from 'active' then 'Paid while the account is not active; refund' end;
  if v_note is not null then
    update gift_orders set payment_ref = p_ref, paid_at = now(), refund_due = true, note = v_note, status = 'cancelled', updated_at = now() where id = p_id returning * into g;
    perform audit('provider:' || p_provider, 'gift.payment_refund', 'gift', p_id::text, jsonb_build_object('ref', p_ref, 'amount', p_amount, 'reason', v_note));
    perform notify_customer(g.customer_id, 'service', 'Payment received, order not placed', g.ref || ': we couldn’t place this order, so your payment will be refunded.', jsonb_build_object('name', 'gift', 'id', g.id), true);
    return jsonb_build_object('status', g.status, 'refund_due', true);
  end if;
  update gift_orders set status = 'placed', payment_ref = p_ref, paid_at = now(), updated_at = now() where id = p_id returning * into g;
  perform notify_customer(g.customer_id, 'service', 'Gift order placed', g.ref || ' · ' || rs(g.total_pkr) || '. Delivery by ' || to_char(g.deliver_by, 'DD Mon') || '.',
    jsonb_build_object('name', 'gift', 'id', g.id), false);
  perform audit('provider:' || p_provider, 'gift.paid', 'gift', p_id::text, jsonb_build_object('ref', p_ref));
  return jsonb_build_object('status', g.status);
end $$;

-- =====================================================================
-- 3. $1 gold: selling
-- =====================================================================
-- Gold prices fresh enough to trade at (selling doesn't need the dollar rate)
create function gold_snapshot() returns rate_snapshots language plpgsql stable as $$
declare s rate_snapshots;
begin
  select * into s from rate_snapshots order by id desc limit 1;
  if not found or s.fetched_at < now() - make_interval(secs => setting_int('rate_stale_seconds')) then perform fail('RATES_STALE'); end if;
  return s;
end $$;

create or replace function fn_micro_sell(p_customer uuid, p_grams numeric, p_iban text, p_key text) returns micro_txns language plpgsql as $$
declare t micro_txns; s rate_snapshots; v_price numeric; v_grams numeric := round(p_grams, 6); v_amount bigint; v_have numeric; v_all boolean;
begin
  if coalesce(p_key, '') = '' then perform fail('BAD_KEY'); end if;
  perform require_active_customer(p_customer, true);
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));
  select * into t from micro_txns where customer_id = p_customer and idempotency_key = p_key;
  if found then return t; end if;
  v_have := micro_grams(p_customer);
  if v_grams is null or v_grams <= 0 then perform fail('BAD_GRAMS'); end if;
  if v_grams > v_have then perform fail('INSUFFICIENT_GOLD'); end if;
  v_all := v_grams = v_have;                                       -- the whole balance can always be sold, however small
  if not v_all and v_grams < (setting('micro_min_sell_g') #>> '{}')::numeric then perform fail('BAD_GRAMS'); end if;
  if coalesce(p_iban, '') !~ '^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$' or not iban_ok(p_iban) then perform fail('BAD_IBAN'); end if;
  s := gold_snapshot();
  v_price := round(s.gold_sell_tola / 11.664, 2);
  v_amount := floor(v_grams * v_price);
  if v_amount < 1 then
    if not v_all then perform fail('BAD_GRAMS'); end if;
    v_amount := 1;                                                 -- dust: PGBX pays at least Rs 1 so the balance can be emptied
  end if;
  insert into micro_txns (ref, side, customer_id, amount_pkr, grams, price_gram, status, payout_to, idempotency_key)
    values (micro_ref('PGBX-MS'), 'sell', p_customer, v_amount, v_grams, v_price, 'pending_payout', p_iban, p_key) returning * into t;
  perform allocate_to_lots('sell', t.id, v_grams);
  perform audit('customer:' || p_customer, 'micro.sold', 'micro', t.ref, jsonb_build_object('grams', v_grams, 'amount', v_amount));
  perform notify_customer(p_customer, 'purchase', 'Gold sold',
    to_char(v_grams, 'FM990.0000') || ' g for ' || rs(v_amount) || ' · ' || t.ref || '. PGBX will pay it to your bank account ending ' || right(p_iban, 4) || '.', jsonb_build_object('name', 'micro'), false);
  return t;
end $$;

-- IBAN checksum (ISO 13616 mod 97), so a mistyped account number is caught before money is sent
create function iban_ok(p_iban text) returns boolean language plpgsql immutable as $$
declare v text := substr(p_iban, 5) || substr(p_iban, 1, 4); d text := ''; ch text; r int := 0; i int;
begin
  if p_iban is null then return false; end if;
  for i in 1..length(v) loop
    ch := substr(v, i, 1);
    d := d || case when ch ~ '[0-9]' then ch else (ascii(ch) - 55)::text end;
  end loop;
  for i in 1..length(d) loop r := (r * 10 + substr(d, i, 1)::int) % 97; end loop;
  return r = 1;
end $$;

-- Payouts: the reference is required and can only be used once
create or replace function fn_micro_payout(p_staff uuid, p_txn uuid, p_ref text) returns micro_txns language plpgsql as $$
declare t micro_txns;
begin
  if length(coalesce(trim(p_ref), '')) < 4 then perform fail('BAD_REF'); end if;
  update micro_txns set status = 'paid_out', payout_ref = trim(p_ref), paid_out_at = now(), paid_out_by = 'staff:' || p_staff
    where id = p_txn and side = 'sell' and status = 'pending_payout' returning * into t;
  if not found then perform fail('NOT_FOUND'); end if;
  perform audit('staff:' || p_staff, 'micro.paid_out', 'micro', t.ref, jsonb_build_object('payout_ref', p_ref, 'amount', t.amount_pkr));
  perform notify_customer(t.customer_id, 'purchase', 'Payment sent', rs(t.amount_pkr) || ' for ' || t.ref || ' was sent to your bank account ending ' || right(t.payout_to, 4) || '.', jsonb_build_object('name', 'micro'), true);
  return t;
end $$;

-- Lots: one bar serial backs one lot
create unique index tola_lots_bar_serial on tola_lots (bar_serial) where side = 'buy' and bar_serial is not null;
create or replace function fn_lot_settle(p_staff uuid, p_lot bigint, p_serial text, p_note text) returns tola_lots language plpgsql as $$
declare l tola_lots; v_serial text := nullif(upper(trim(coalesce(p_serial, ''))), '');
begin
  select * into l from tola_lots where id = p_lot for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if l.status <> 'full' then perform fail('LOT_NOT_FULL'); end if;
  if l.side = 'buy' and length(coalesce(v_serial, '')) < 3 then perform fail('SERIALS_REQUIRED'); end if;
  if l.side = 'buy' and exists (select 1 from tola_lots where side = 'buy' and bar_serial = v_serial) then perform fail('BAR_SERIAL_USED'); end if;
  update tola_lots set status = 'settled', settled_at = now(), settled_by = 'staff:' || p_staff, bar_serial = v_serial, settle_note = p_note
    where id = p_lot returning * into l;
  perform audit('staff:' || p_staff, 'lot.settled', 'lot', l.ref, jsonb_build_object('side', l.side, 'serial', v_serial, 'note', p_note));
  return l;
end $$;

-- Each allocation keeps its share of the transaction's rupees, so a lot's value adds up exactly
alter table lot_allocations add column amount_pkr numeric(16, 4);
create or replace function allocate_to_lots(p_side text, p_txn uuid, p_grams numeric) returns void language plpgsql as $$
declare v_left numeric := p_grams; l tola_lots; v_take numeric; v_no int; t micro_txns;
begin
  select * into t from micro_txns where id = p_txn;
  perform pg_advisory_xact_lock(hashtext('lots:' || p_side));
  while v_left > 0 loop
    select * into l from tola_lots where side = p_side and status = 'filling' for update;
    if not found then
      select coalesce(max(no), 0) + 1 into v_no from tola_lots where side = p_side;
      insert into tola_lots (side, no, ref) values (p_side, v_no, case when p_side = 'buy' then 'PGBX-T-' else 'PGBX-TS-' end || lpad(v_no::text, 6, '0'))
        returning * into l;
    end if;
    v_take := least(v_left, l.grams_target - l.grams_filled);
    insert into lot_allocations (lot_id, txn_id, grams, amount_pkr) values (l.id, p_txn, v_take, round(t.amount_pkr * v_take / t.grams, 4));
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

-- =====================================================================
-- 4. Expiry: transactions of lapsed orders lapse too (also after an account closes); expiry is audited
-- =====================================================================
create or replace function fn_expire_micro() returns int language plpgsql as $$
declare n int;
begin
  update micro_orders set status = 'expired' where status = 'pending_payment'
    and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int);
  get diagnostics n = row_count;
  update micro_txns t set status = 'expired' from micro_orders o where o.id = t.order_id and t.status = 'pending_payment' and o.status in ('expired', 'refunded');
  if n > 0 then perform audit('system', 'micro.expired', 'micro', null, jsonb_build_object('orders', n)); end if;
  return n;
end $$;

create or replace function fn_expire_services() returns int language plpgsql as $$
declare n int; m int;
begin
  update appraisals set status = 'cancelled', updated_at = now() where status = 'pending_payment' and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int);
  get diagnostics n = row_count;
  update gift_orders set status = 'cancelled', updated_at = now() where status = 'pending_payment' and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int);
  get diagnostics m = row_count;
  if n + m > 0 then perform audit('system', 'services.expired', 'service', null, jsonb_build_object('appraisals', n, 'gifts', m)); end if;
  return n + m;
end $$;

-- =====================================================================
-- 5. Account closure: locks the customer, includes $1 gold and refunds, and expires everything left unpaid
-- =====================================================================
create or replace function fn_close_account(p_customer uuid) returns jsonb language plpgsql as $$
declare v_blockers jsonb := '[]'; v_units int; v_active int; v_flagged int; v_services int; v_grams numeric; v_payouts int; c customers;
begin
  select * into c from customers where id = p_customer for update;     -- waits for any purchase or payment in flight
  if not found or c.status <> 'active' then perform fail('ACCOUNT_INACTIVE'); end if;
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
  update customers set status = 'closed', closed_at = now(), closed_phone = phone, phone = null where id = p_customer;
  update sessions set revoked_at = now() where customer_id = p_customer and revoked_at is null;
  delete from push_tokens where customer_id = p_customer;
  update price_alerts set active = false where customer_id = p_customer;
  update appraisals set status = 'cancelled', updated_at = now() where customer_id = p_customer and status = 'pending_payment';
  update gift_orders set status = 'cancelled', updated_at = now() where customer_id = p_customer and status = 'pending_payment';
  update micro_orders set status = 'expired' where customer_id = p_customer and status = 'pending_payment';
  update micro_txns t set status = 'expired' from micro_orders o where o.id = t.order_id and o.customer_id = p_customer and t.status = 'pending_payment';
  perform audit('customer:' || p_customer, 'account.closed', 'customer', p_customer::text, '{}');
  return jsonb_build_object('closed', true, 'blockers', '[]'::jsonb);
end $$;

-- Retention is applied when purging (closing date + the current setting), so accounts closed before PGBX set a
-- retention period are purged once it is set. Purge also removes identity-check details, device names and IBANs.
create or replace function fn_purge_closed() returns int language plpgsql as $$
declare n int; v_days bigint := setting_int('retention_days');
begin
  if v_days is null then return 0; end if;
  with p as (
    update customers set name = null, cnic = null, dob = null, email = null, address = null, closed_phone = null, purged_at = now()
    where status = 'closed' and purged_at is null and closed_at < now() - make_interval(days => v_days::int) returning id
  ), d as (delete from notifications where customer_id in (select id from p)
  ), r as (delete from support_requests where customer_id in (select id from p)
  ), k as (update kyc_checks set reason = null, provider_ref = null, data = '{}' where customer_id in (select id from p)
  ), s as (update sessions set device = null where customer_id in (select id from p)
  ), a as (update appraisals set address = '[removed]', area = '[removed]', phone = '[removed]', notes = null, visit_code = '0000', goldsmith_name = null, goldsmith_phone = null where customer_id in (select id from p)
  ), g as (update gift_orders set recipient_name = '[removed]', recipient_phone = '[removed]', recipient_address = '[removed]', message = null, engraving = null
     where customer_id in (select id from p)
  ), m as (update micro_txns set payout_to = 'PK00REMOVED0000000000000' where customer_id in (select id from p) and side = 'sell' and status = 'paid_out')
  select count(*) into n from p;
  if n > 0 then perform audit('system', 'customers.purged', 'customer', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;
-- Accounts already closed get a purge date on the same rule (kept for display in the admin panel)
update customers set purge_after = null where status = 'closed' and purged_at is null;

-- =====================================================================
-- 6. Records that must not be changed or deleted: $1 gold transactions, lots, allocations, payments and refunds
-- =====================================================================
create function micro_append_only() returns trigger language plpgsql as $$
declare v_new jsonb; v_old jsonb; k text; v_keys text[];
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'APPEND_ONLY: % rows cannot be deleted', tg_table_name; end if;
  if tg_table_name in ('lot_allocations', 'service_payments') then raise exception 'APPEND_ONLY: % rows cannot be changed', tg_table_name; end if;
  v_new := to_jsonb(new); v_old := to_jsonb(old);
  v_keys := case tg_table_name
    when 'micro_txns' then array['ref', 'side', 'customer_id', 'order_id', 'amount_pkr', 'grams', 'price_gram', 'created_at']
    when 'micro_orders' then array['ref', 'customer_id', 'units', 'unit_pkr', 'total_pkr', 'price_gram', 'created_at']
    when 'tola_lots' then array['ref', 'side', 'no', 'grams_target']
    when 'refunds' then array['kind', 'entity_id', 'payment_ref', 'amount_pkr', 'created_at']
    else array[]::text[] end;
  foreach k in array v_keys loop
    if v_new -> k is distinct from v_old -> k then raise exception 'APPEND_ONLY: %.% cannot change', tg_table_name, k; end if;
  end loop;
  if tg_table_name = 'tola_lots' and (v_new ->> 'grams_filled')::numeric < (v_old ->> 'grams_filled')::numeric then
    raise exception 'APPEND_ONLY: a lot can only fill up';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['micro_txns', 'micro_orders', 'tola_lots', 'lot_allocations', 'service_payments', 'refunds'] loop
    execute format('create trigger %I before update or delete on %I for each row execute function micro_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function micro_append_only()', t || '_no_truncate', t);
  end loop;
end $$;
create trigger audit_no_truncate before truncate on audit_log for each statement execute function audit_append_only();

-- =====================================================================
-- 7. Constraints
-- =====================================================================
alter table micro_orders add constraint micro_orders_total check (total_pkr = units * unit_pkr);
alter table micro_txns add constraint micro_txns_side_fields check ((side = 'buy') = (order_id is not null) and (side = 'sell') = (payout_to is not null));
alter table tola_lots add constraint tola_lots_one_tola check (grams_target = 11.664);
create unique index micro_orders_payment_ref on micro_orders (payment_ref) where payment_ref is not null;
create unique index micro_txns_payout_ref on micro_txns (payout_ref) where payout_ref is not null;
create unique index appraisals_payment_ref on appraisals (payment_ref) where payment_ref is not null;
create unique index gift_orders_payment_ref on gift_orders (payment_ref) where payment_ref is not null;
-- One verified identity per CNIC among open accounts
create unique index customers_verified_cnic on customers (cnic) where status <> 'closed' and kyc_status in ('verified', 'reverify') and cnic is not null;

-- =====================================================================
-- 8. Rates and alerts: the dollar rate is stored with the snapshot in one statement; alerts fire in one set-based
--    statement; old unreferenced snapshots are pruned by housekeeping.
-- =====================================================================
drop function fn_record_rates(bigint, bigint, bigint, bigint, text);
create function fn_record_rates(p_gold_buy bigint, p_gold_sell bigint, p_silver_buy bigint, p_silver_sell bigint, p_source text, p_usd_pkr numeric default null)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into rate_snapshots (gold_buy_tola, gold_sell_tola, silver_buy_tola, silver_sell_tola, source, usd_pkr)
  values (p_gold_buy, p_gold_sell, p_silver_buy, p_silver_sell, p_source, p_usd_pkr) returning id into v_id;
  perform fn_fire_alerts(v_id);
  return v_id;
end $$;

drop index if exists price_alerts_metal_idx;
create index price_alerts_firing on price_alerts (metal, dir, target_pkr) where active;
create or replace function fn_fire_alerts(p_snapshot bigint) returns int language plpgsql as $$
declare s rate_snapshots; n int;
begin
  select * into s from rate_snapshots where id = p_snapshot;
  if not found then return 0; end if;
  with f as (
    update price_alerts set active = false, fired_at = now()
    where active and (
      (metal = 'gold' and ((dir = 'above' and target_pkr <= s.gold_buy_tola) or (dir = 'below' and target_pkr >= s.gold_buy_tola))) or
      (metal = 'silver' and ((dir = 'above' and target_pkr <= s.silver_buy_tola) or (dir = 'below' and target_pkr >= s.silver_buy_tola))))
    returning customer_id, metal, dir, target_pkr
  ), ins as (
    insert into notifications (customer_id, kind, title, body, link, push)
    select customer_id, 'alert', initcap(metal) || ' is ' || dir || ' ' || rs(target_pkr),
      'Buy rate is now ' || rs(case when metal = 'gold' then s.gold_buy_tola else s.silver_buy_tola end) || ' per tola.',
      jsonb_build_object('name', 'history', 'metal', metal), true from f
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

create or replace function fn_housekeeping() returns int language plpgsql as $$
declare n int := 0; m int;
begin
  delete from price_locks l where l.expires_at < now() - interval '2 days' and not exists (select 1 from orders o where o.lock_id = l.id);
  get diagnostics m = row_count; n := n + m;
  delete from sessions where (revoked_at is not null or expires_at < now()) and coalesce(revoked_at, expires_at) < now() - interval '30 days';
  get diagnostics m = row_count; n := n + m;
  delete from staff_sessions where (revoked_at is not null or expires_at < now()) and coalesce(revoked_at, expires_at) < now() - interval '30 days';
  get diagnostics m = row_count; n := n + m;
  -- rate snapshots older than 3 days that no price lock or gift order uses (the newest is always kept)
  delete from rate_snapshots s where s.fetched_at < now() - interval '3 days' and s.id < (select max(id) from rate_snapshots)
    and not exists (select 1 from price_locks l where l.snapshot_id = s.id) and not exists (select 1 from gift_orders g where g.rate_snapshot = s.id);
  get diagnostics m = row_count; n := n + m;
  delete from rate_limits where window_start < now() - interval '1 day';
  get diagnostics m = row_count; n := n + m;
  return n;
end $$;

-- =====================================================================
-- 9. Reconciliation covers $1 gold, services and refunds
-- =====================================================================
create or replace function fn_reconcile(p_day date) returns jsonb language plpgsql stable as $$
declare v jsonb; v_from timestamptz := pk_day_start(p_day); v_to timestamptz := pk_day_start(p_day + 1);
begin
  select jsonb_build_object(
    'day', p_day,
    'payments_succeeded_pkr', (select coalesce(sum(amount_pkr), 0) from payments where status = 'succeeded' and created_at >= v_from and created_at < v_to),
    'orders_credited_pkr', (select coalesce(sum(o.total_pkr), 0) from orders o where o.status = 'credited' and o.credited_at >= v_from and o.credited_at < v_to),
    'extra_payments', (select coalesce(jsonb_agg(jsonb_build_object('order', x.order_id, 'payments', x.n)), '[]') from
       (select order_id, count(*) n from payments where status = 'succeeded' group by order_id having count(*) > 1) x),
    'paid_not_credited', (select coalesce(jsonb_agg(jsonb_build_object('order', o.id, 'receipt', o.receipt_no, 'status', o.status, 'total', o.total_pkr)), '[]')
       from orders o where exists (select 1 from payments p where p.order_id = o.id and p.status = 'succeeded') and o.status not in ('credited', 'refunded')),
    'credited_without_payment', (select coalesce(jsonb_agg(jsonb_build_object('order', o.id, 'receipt', o.receipt_no)), '[]')
       from orders o where o.status = 'credited' and o.resolved_by is null and not exists (select 1 from payments p where p.order_id = o.id and p.status = 'succeeded')),
    'metal', (select coalesce(jsonb_agg(m order by m ->> 'product_id'), '[]') from (
       select jsonb_build_object('product_id', pr.id,
         'customer_units', coalesce((select sum(delta) from ledger l where l.product_id = pr.id), 0),
         'reserved_units', coalesce((select sum(units) from redemptions r where r.product_id = pr.id and r.status in ('requested', 'ready') and r.expires_at > now()), 0),
         'dealer_units', coalesce((select sum(units) from dealer_stock s where s.product_id = pr.id), 0),
         'vault_units', (select units from vault_counts v where v.product_id = pr.id order by counted_at desc limit 1),
         'vault_counted_at', (select counted_at from vault_counts v where v.product_id = pr.id order by counted_at desc limit 1)) as m
       from products pr) x),
    'flagged_orders', (select count(*) from orders where status = 'flagged'),
    -- money for $1 gold and services received that day, and what it was used for
    'services', jsonb_build_object(
      'received_pkr', (select coalesce(jsonb_object_agg(kind, pkr), '{}') from (select kind, sum(amount_pkr) pkr from service_payments where created_at >= v_from and created_at < v_to group by kind) x),
      'micro_credited_pkr', (select coalesce(sum(total_pkr), 0) from micro_orders where status = 'credited' and paid_at >= v_from and paid_at < v_to),
      'micro_paid_not_credited', (select coalesce(jsonb_agg(jsonb_build_object('ref', o.ref, 'status', o.status, 'total', o.total_pkr)), '[]')
         from micro_orders o where exists (select 1 from service_payments p where p.kind = 'micro' and p.entity_id = o.id) and o.status not in ('credited', 'refund_due', 'refunded'))),
    -- $1 gold metal: what customers own against the tola bars PGBX holds for them
    'micro', (select jsonb_build_object(
        'customer_grams', coalesce((select sum(case when side = 'buy' then grams else -grams end) from micro_txns where side = 'sell' or status = 'credited'), 0),
        'bars_held_grams', 11.664 * ((select count(*) from tola_lots where side = 'buy' and status = 'settled') - (select count(*) from tola_lots where side = 'sell' and status = 'settled')),
        'buy_lots_to_settle', (select count(*) from tola_lots where side = 'buy' and status = 'full'),
        'sell_lots_to_settle', (select count(*) from tola_lots where side = 'sell' and status = 'full'),
        'payouts_pending', (select count(*) from micro_txns where status = 'pending_payout'),
        'payouts_pending_pkr', (select coalesce(sum(amount_pkr), 0) from micro_txns where status = 'pending_payout'),
        'payouts_overdue', (select count(*) from micro_txns where status = 'pending_payout' and created_at < now() - interval '2 days'))),
    'refunds_due', (select jsonb_build_object('count', count(*), 'pkr', coalesce(sum(amount_pkr), 0)) from refunds where status = 'due')
  ) into v;
  return v;
end $$;

-- =====================================================================
-- 10. Performance: indexes for frequent lookups; drop a duplicate
-- =====================================================================
drop index if exists sessions_customer_id_idx;
create index on orders (lock_id);
create index on price_locks (expires_at);
create index on support_requests (customer_id);
create index on rate_limits (window_start);
create index on redemptions (customer_id, product_id) where status in ('requested', 'ready');
create index micro_txns_balance on micro_txns (customer_id) include (side, status, grams);

-- =====================================================================
-- 10b. Small additions used by the API
-- =====================================================================
-- Current count for a rate-limit key without adding to it (failed sign-ins are counted only when they fail)
create function rate_hits(p_key text, p_window_secs int) returns int language sql stable as $$
  select coalesce((select hits from rate_limits where key = p_key
    and window_start = to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs)), 0)
$$;
-- Sales and collections pause for a day after the mobile number changes (account-takeover protection)
alter table customers add column phone_changed_at timestamptz;
-- Unused
drop view if exists v_reserved;

-- =====================================================================
-- 11. Hardening: fixed search_path on every function; rs() depends on locale settings, so it is stable
-- =====================================================================
alter function rs(bigint) stable;
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('alter function %s set search_path = public, pg_temp', f);
  end loop;
end $$;

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
