-- =====================================================================
-- PGBX services: jewellery worth estimate, doorstep appraisal, gift bullion and coins made to order.
-- Same rules as the core: the server prices everything from its own fresh rate snapshot, every change is audited,
-- customers are notified, and payment is recorded once.
-- Values marked SAMPLE are placeholders until PGBX sets them in the admin panel (Settings).
-- =====================================================================

insert into settings (key, value) values
  -- Jewellery worth: fineness of each karat / silver standard, and the buy-back deduction (SAMPLE)
  ('purity', '{"gold": {"24K": 0.999, "22K": 0.916, "21K": 0.875, "20K": 0.833, "18K": 0.750, "14K": 0.585}, "silver": {"999": 0.999, "925": 0.925, "900": 0.900, "800": 0.800}}'),
  ('buyback_deduction_pct', '{"gold": 4, "silver": 6}'),
  -- Doorstep appraisal (SAMPLE)
  ('appraisal_fee_pkr', '2500'),
  ('appraisal_cities', '["Karachi"]'),
  ('appraisal_slots', '["10:00-12:00", "12:00-14:00", "14:00-16:00", "16:00-18:00", "18:00-20:00"]'),
  ('appraisal_free_cancel_hours', '24'),
  -- Gift bullion and coins (SAMPLE)
  ('gift_making_pkr', '{"plain": 1500, "themed": 2500, "engraving": 1000}'),
  ('gift_packaging_pkr', '{"standard": 0, "premium": 1500}'),
  ('gift_delivery_pkr', '1500'),
  ('gift_lead_days', '5'),
  ('gift_cities', '["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta", "Hyderabad", "Sialkot"]');

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('purchase', 'redemption', 'security', 'account', 'alert', 'service'));

-- What can be made to order. Coins exist only for some weights.
create table gift_items (
  id text primary key,
  metal text not null check (metal in ('gold', 'silver')),
  label text not null,
  grams numeric(10, 3) not null check (grams > 0),
  shapes text[] not null,
  active boolean not null default true,
  sort int not null default 0
);
insert into gift_items (id, metal, label, grams, shapes, sort) values
  ('gg-1g', 'gold', '1 gram', 1, '{bar,coin}', 1), ('gg-2g', 'gold', '2 gram', 2, '{bar,coin}', 2),
  ('gg-5g', 'gold', '5 gram', 5, '{bar,coin}', 3), ('gg-1t', 'gold', '1 tola', 11.664, '{bar,coin}', 4),
  ('gg-10g', 'gold', '10 gram', 10, '{bar}', 5),
  ('gs-1t', 'silver', '1 tola', 11.664, '{bar,coin}', 6), ('gs-5t', 'silver', '5 tola', 58.32, '{bar,coin}', 7),
  ('gs-10t', 'silver', '10 tola', 116.64, '{bar}', 8);

create sequence service_seq;

create table appraisals (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  customer_id uuid not null references customers(id),
  city text not null, area text not null, address text not null, phone text not null,
  visit_date date not null, slot text not null,
  items jsonb not null,                                      -- [{metal, karat, approx_g, note}]
  notes text,
  fee_pkr bigint not null,
  visit_code text not null,                                  -- the goldsmith must say this at the door
  status text not null default 'pending_payment' check (status in ('pending_payment', 'booked', 'confirmed', 'completed', 'cancelled')),
  goldsmith_name text, goldsmith_phone text,
  result jsonb,                                              -- assay result recorded by operations
  payment_ref text, paid_at timestamptz,
  refund_due boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on appraisals (customer_id, created_at desc);
create index on appraisals (status, visit_date);

create table gift_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  customer_id uuid not null references customers(id),
  item_id text not null references gift_items(id),
  shape text not null check (shape in ('bar', 'coin')),
  design text not null check (design in ('plain', 'eid', 'wedding', 'birthday', 'newborn', 'graduation')),
  engraving text check (length(engraving) <= 24),
  message text check (length(message) <= 200),
  packaging text not null check (packaging in ('standard', 'premium')),
  recipient_name text not null, recipient_phone text not null, recipient_city text not null, recipient_address text not null,
  deliver_by date not null,
  metal_pkr bigint not null, making_pkr bigint not null, packaging_pkr bigint not null, delivery_pkr bigint not null, total_pkr bigint not null,
  rate_snapshot bigint not null references rate_snapshots(id),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'placed', 'in_production', 'dispatched', 'delivered', 'cancelled')),
  tracking text,
  payment_ref text, paid_at timestamptz,
  refund_due boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on gift_orders (customer_id, created_at desc);
create index on gift_orders (status, deliver_by);

alter table gift_items enable row level security;
alter table appraisals enable row level security;
alter table gift_orders enable row level security;

-- ---------- doorstep appraisal ----------
create function fn_book_appraisal(p_customer uuid, p_city text, p_area text, p_address text, p_phone text, p_date date, p_slot text,
  p_items jsonb, p_notes text, p_visit_code text) returns appraisals language plpgsql as $$
declare v appraisals;
begin
  perform require_active_customer(p_customer, false);
  if not (setting('appraisal_cities') ? p_city) then perform fail('CITY_NOT_SERVED'); end if;
  if not (setting('appraisal_slots') ? p_slot) then perform fail('BAD_SLOT'); end if;
  if p_date <= current_date or p_date > current_date + 30 then perform fail('BAD_DATE'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then perform fail('NO_ITEMS'); end if;
  if length(coalesce(p_address, '')) < 10 or length(coalesce(p_area, '')) < 2 then perform fail('BAD_ADDRESS'); end if;
  if (select count(*) from appraisals where visit_date = p_date and slot = p_slot and status in ('booked', 'confirmed')) >= 6 then perform fail('SLOT_FULL'); end if;
  insert into appraisals (ref, customer_id, city, area, address, phone, visit_date, slot, items, notes, fee_pkr, visit_code)
  values ('PGBX-A-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('service_seq')::text, 5, '0'), p_customer, p_city, p_area, p_address, p_phone,
    p_date, p_slot, p_items, nullif(p_notes, ''), setting_int('appraisal_fee_pkr'), p_visit_code)
  returning * into v;
  perform audit('customer:' || p_customer, 'appraisal.created', 'appraisal', v.id::text, jsonb_build_object('date', p_date, 'slot', p_slot));
  return v;
end $$;

create function fn_cancel_appraisal(p_customer uuid, p_id uuid) returns appraisals language plpgsql as $$
declare v appraisals; v_start timestamptz;
begin
  select * into v from appraisals where id = p_id and customer_id = p_customer for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if v.status not in ('pending_payment', 'booked', 'confirmed') then perform fail('CANNOT_CANCEL'); end if;
  v_start := (v.visit_date + split_part(v.slot, '-', 1)::time) at time zone 'Asia/Karachi';
  update appraisals set status = 'cancelled', updated_at = now(),
    refund_due = v.status <> 'pending_payment' and v_start - now() >= make_interval(hours => setting_int('appraisal_free_cancel_hours')::int)
  where id = p_id returning * into v;
  perform audit('customer:' || p_customer, 'appraisal.cancelled', 'appraisal', p_id::text, jsonb_build_object('refund', v.refund_due));
  return v;
end $$;

create function fn_appraisal_update(p_staff uuid, p_id uuid, p_action text, p_data jsonb) returns appraisals language plpgsql as $$
declare v appraisals;
begin
  select * into v from appraisals where id = p_id for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if p_action = 'assign' and v.status in ('booked', 'confirmed') then
    if length(coalesce(p_data ->> 'name', '')) < 3 or length(coalesce(p_data ->> 'phone', '')) < 7 then perform fail('BAD_GOLDSMITH'); end if;
    update appraisals set status = 'confirmed', goldsmith_name = p_data ->> 'name', goldsmith_phone = p_data ->> 'phone', updated_at = now() where id = p_id returning * into v;
    perform notify_customer(v.customer_id, 'service', 'Appraisal confirmed',
      p_data ->> 'name' || ' will visit on ' || to_char(v.visit_date, 'DD Mon') || ', ' || v.slot || '. Ask for your visit code before opening the door.',
      jsonb_build_object('name', 'appraisal', 'id', v.id), true);
  elsif p_action = 'complete' and v.status = 'confirmed' then
    update appraisals set status = 'completed', result = p_data, updated_at = now() where id = p_id returning * into v;
    perform notify_customer(v.customer_id, 'service', 'Appraisal report ready', 'Your assay results are in the app.', jsonb_build_object('name', 'appraisal', 'id', v.id), true);
  elsif p_action = 'cancel' and v.status in ('pending_payment', 'booked', 'confirmed') then
    update appraisals set status = 'cancelled', refund_due = v.status <> 'pending_payment', updated_at = now() where id = p_id returning * into v;
    perform notify_customer(v.customer_id, 'service', 'Appraisal cancelled by PGBX',
      coalesce(p_data ->> 'reason', 'We couldn’t make this visit.') || case when v.refund_due then ' Your fee will be refunded.' else '' end,
      jsonb_build_object('name', 'appraisal', 'id', v.id), true);
  else perform fail('BAD_ACTION');
  end if;
  perform audit('staff:' || p_staff, 'appraisal.' || p_action, 'appraisal', p_id::text, coalesce(p_data, '{}'));
  return v;
end $$;

-- ---------- gift bullion and coins ----------
-- Price of a made-to-order piece from the latest fresh snapshot: metal at the buy rate + making + packaging + delivery.
create function fn_gift_quote(p_item text, p_shape text, p_design text, p_engraving text, p_packaging text)
returns jsonb language plpgsql stable as $$
declare i gift_items; s rate_snapshots; v_metal bigint; v_making bigint; v_pack bigint; v_del bigint; m jsonb := setting('gift_making_pkr');
begin
  select * into i from gift_items where id = p_item and active;
  if not found then perform fail('UNKNOWN_PRODUCT'); end if;
  if not (p_shape = any(i.shapes)) then perform fail('BAD_SHAPE'); end if;
  if p_design not in ('plain', 'eid', 'wedding', 'birthday', 'newborn', 'graduation') then perform fail('BAD_DESIGN'); end if;
  if p_packaging not in ('standard', 'premium') then perform fail('BAD_PACKAGING'); end if;
  if length(coalesce(p_engraving, '')) > 24 then perform fail('ENGRAVING_TOO_LONG'); end if;
  select * into s from rate_snapshots order by id desc limit 1;
  if s.id is null or s.fetched_at < now() - make_interval(secs => setting_int('rate_stale_seconds')) then perform fail('RATES_STALE'); end if;
  v_metal := round(i.grams * (case when i.metal = 'gold' then s.gold_buy_tola else s.silver_buy_tola end) / 11.664);
  v_making := (m ->> case when p_design = 'plain' then 'plain' else 'themed' end)::bigint + case when coalesce(p_engraving, '') <> '' then (m ->> 'engraving')::bigint else 0 end;
  v_pack := (setting('gift_packaging_pkr') ->> p_packaging)::bigint;
  v_del := setting_int('gift_delivery_pkr');
  return jsonb_build_object('item', p_item, 'metal_pkr', v_metal, 'making_pkr', v_making, 'packaging_pkr', v_pack, 'delivery_pkr', v_del,
    'total_pkr', v_metal + v_making + v_pack + v_del, 'snapshot', s.id, 'priced_at', s.fetched_at);
end $$;

create function fn_place_gift(p_customer uuid, p_item text, p_shape text, p_design text, p_engraving text, p_message text, p_packaging text,
  p_name text, p_phone text, p_city text, p_address text, p_deliver_by date) returns gift_orders language plpgsql as $$
declare q jsonb; v gift_orders;
begin
  perform require_active_customer(p_customer, true);                     -- buying metal: identity verified
  q := fn_gift_quote(p_item, p_shape, p_design, p_engraving, p_packaging);
  if not (setting('gift_cities') ? p_city) then perform fail('CITY_NOT_SERVED'); end if;
  if length(coalesce(p_name, '')) < 3 or length(coalesce(p_address, '')) < 10 or length(coalesce(p_phone, '')) < 10 then perform fail('BAD_RECIPIENT'); end if;
  if p_deliver_by < current_date + setting_int('gift_lead_days')::int or p_deliver_by > current_date + 60 then perform fail('BAD_DATE'); end if;
  if (select coalesce(sum(total_pkr), 0) from orders where customer_id = p_customer and status in ('pending_payment', 'credited', 'flagged') and created_at >= date_trunc('day', now()))
     + (select coalesce(sum(total_pkr), 0) from gift_orders where customer_id = p_customer and status <> 'cancelled' and created_at >= date_trunc('day', now()))
     + (q ->> 'total_pkr')::bigint > setting_int('daily_limit_pkr') then perform fail('DAILY_LIMIT'); end if;
  insert into gift_orders (ref, customer_id, item_id, shape, design, engraving, message, packaging, recipient_name, recipient_phone, recipient_city,
    recipient_address, deliver_by, metal_pkr, making_pkr, packaging_pkr, delivery_pkr, total_pkr, rate_snapshot)
  values ('PGBX-G-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('service_seq')::text, 5, '0'), p_customer, p_item, p_shape, p_design,
    nullif(p_engraving, ''), nullif(p_message, ''), p_packaging, p_name, p_phone, p_city, p_address, p_deliver_by,
    (q ->> 'metal_pkr')::bigint, (q ->> 'making_pkr')::bigint, (q ->> 'packaging_pkr')::bigint, (q ->> 'delivery_pkr')::bigint, (q ->> 'total_pkr')::bigint, (q ->> 'snapshot')::bigint)
  returning * into v;
  perform audit('customer:' || p_customer, 'gift.created', 'gift', v.id::text, jsonb_build_object('item', p_item, 'total', v.total_pkr));
  return v;
end $$;

create function fn_cancel_gift(p_customer uuid, p_id uuid) returns gift_orders language plpgsql as $$
declare v gift_orders;
begin
  select * into v from gift_orders where id = p_id and customer_id = p_customer for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if v.status not in ('pending_payment', 'placed') then perform fail('CANNOT_CANCEL'); end if;   -- once in production it's being made for you
  update gift_orders set status = 'cancelled', refund_due = v.status = 'placed', updated_at = now() where id = p_id returning * into v;
  perform audit('customer:' || p_customer, 'gift.cancelled', 'gift', p_id::text, jsonb_build_object('refund', v.refund_due));
  return v;
end $$;

create function fn_gift_update(p_staff uuid, p_id uuid, p_action text, p_data jsonb) returns gift_orders language plpgsql as $$
declare v gift_orders; v_next text; v_title text; v_body text;
begin
  select * into v from gift_orders where id = p_id for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if p_action = 'produce' and v.status = 'placed' then v_next := 'in_production'; v_title := 'Your gift is being made'; v_body := v.ref || ' is in production at the PGBX refinery.';
  elsif p_action = 'dispatch' and v.status = 'in_production' then
    if length(coalesce(p_data ->> 'tracking', '')) < 4 then perform fail('TRACKING_REQUIRED'); end if;
    v_next := 'dispatched'; v_title := 'Your gift is on its way'; v_body := 'Insured courier, tracking ' || (p_data ->> 'tracking') || '. The recipient will need their CNIC.';
  elsif p_action = 'deliver' and v.status = 'dispatched' then v_next := 'delivered'; v_title := 'Gift delivered'; v_body := v.ref || ' was delivered to ' || v.recipient_name || '.';
  elsif p_action = 'cancel' and v.status in ('pending_payment', 'placed', 'in_production') then v_next := 'cancelled'; v_title := 'Gift order cancelled by PGBX';
    v_body := coalesce(p_data ->> 'reason', 'We couldn’t complete this order.') || ' Your payment will be refunded.';
  else perform fail('BAD_ACTION');
  end if;
  update gift_orders set status = v_next, tracking = coalesce(p_data ->> 'tracking', tracking), refund_due = refund_due or (v_next = 'cancelled' and v.status <> 'pending_payment'),
    updated_at = now() where id = p_id returning * into v;
  perform notify_customer(v.customer_id, 'service', v_title, v_body, jsonb_build_object('name', 'gift', 'id', v.id), true);
  perform audit('staff:' || p_staff, 'gift.' || p_action, 'gift', p_id::text, coalesce(p_data, '{}'));
  return v;
end $$;

-- ---------- payment for a service (once; wrong amount is refused) ----------
create function fn_service_paid(p_kind text, p_id uuid, p_ref text, p_amount bigint) returns jsonb language plpgsql as $$
declare a appraisals; g gift_orders;
begin
  if p_kind = 'appraisal' then
    select * into a from appraisals where id = p_id for update;
    if not found then perform fail('NOT_FOUND'); end if;
    if a.status <> 'pending_payment' then return jsonb_build_object('status', a.status, 'duplicate', true); end if;
    if p_amount <> a.fee_pkr then perform fail('AMOUNT_MISMATCH'); end if;
    update appraisals set status = 'booked', payment_ref = p_ref, paid_at = now(), updated_at = now() where id = p_id returning * into a;
    perform notify_customer(a.customer_id, 'service', 'Appraisal booked',
      a.ref || ' · ' || to_char(a.visit_date, 'DD Mon') || ', ' || a.slot || '. We’ll confirm your goldsmith before the visit.', jsonb_build_object('name', 'appraisal', 'id', a.id), false);
    perform audit('provider', 'appraisal.paid', 'appraisal', p_id::text, jsonb_build_object('ref', p_ref));
    return jsonb_build_object('status', a.status);
  elsif p_kind = 'gift' then
    select * into g from gift_orders where id = p_id for update;
    if not found then perform fail('NOT_FOUND'); end if;
    if g.status <> 'pending_payment' then return jsonb_build_object('status', g.status, 'duplicate', true); end if;
    if p_amount <> g.total_pkr then perform fail('AMOUNT_MISMATCH'); end if;
    update gift_orders set status = 'placed', payment_ref = p_ref, paid_at = now(), updated_at = now() where id = p_id returning * into g;
    perform notify_customer(g.customer_id, 'service', 'Gift order placed', g.ref || ' · ' || rs(g.total_pkr) || '. Delivery by ' || to_char(g.deliver_by, 'DD Mon') || '.',
      jsonb_build_object('name', 'gift', 'id', g.id), false);
    perform audit('provider', 'gift.paid', 'gift', p_id::text, jsonb_build_object('ref', p_ref));
    return jsonb_build_object('status', g.status);
  end if;
  perform fail('BAD_ACTION');
end $$;

-- Unpaid bookings and gift orders lapse after the payment window, like purchase orders
create function fn_expire_services() returns int language plpgsql as $$
declare n int; m int;
begin
  update appraisals set status = 'cancelled', updated_at = now() where status = 'pending_payment' and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int);
  get diagnostics n = row_count;
  update gift_orders set status = 'cancelled', updated_at = now() where status = 'pending_payment' and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int);
  get diagnostics m = row_count;
  return n + m;
end $$;

-- ---------- account closure and purge cover services too ----------
-- An open appraisal or gift order blocks closing the account, like open orders do.
create or replace function fn_close_account(p_customer uuid) returns jsonb language plpgsql as $$
declare v_blockers jsonb := '[]'; v_units int; v_active int; v_flagged int; v_services int; v_days bigint;
begin
  perform require_active_customer(p_customer, false);
  select coalesce(sum(units), 0) into v_units from v_holdings where customer_id = p_customer;
  select count(*) into v_active from redemptions where customer_id = p_customer and status in ('requested', 'ready') and expires_at > now();
  select count(*) into v_flagged from orders where customer_id = p_customer and status in ('flagged', 'pending_payment');
  select (select count(*) from appraisals where customer_id = p_customer and status in ('booked', 'confirmed'))
       + (select count(*) from gift_orders where customer_id = p_customer and status in ('placed', 'in_production', 'dispatched')) into v_services;
  if v_units > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'HOLDINGS', 'units', v_units); end if;
  if v_active > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'ACTIVE_REDEMPTIONS', 'count', v_active); end if;
  if v_flagged > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'OPEN_ORDERS', 'count', v_flagged); end if;
  if v_services > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'OPEN_SERVICES', 'count', v_services); end if;
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
  perform audit('customer:' || p_customer, 'account.closed', 'customer', p_customer::text, '{}');
  return jsonb_build_object('closed', true, 'blockers', '[]'::jsonb);
end $$;

-- Purge also removes home addresses and recipients' details; amounts and dates stay for the records.
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
     where customer_id in (select id from p))
  select count(*) into n from p;
  if n > 0 then perform audit('system', 'customers.purged', 'customer', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;
