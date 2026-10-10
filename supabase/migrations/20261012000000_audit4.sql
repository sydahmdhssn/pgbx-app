-- Which version of the terms and privacy policy each customer accepted, and when (shown at login; asked again when
-- the terms change). Audited as terms.accepted.
alter table customers add column terms_version text check (terms_version ~ '^[0-9A-Za-z._-]{1,20}$');
alter table customers add column terms_accepted_at timestamptz;

-- =====================================================================
-- Audit fixes (2026-10-12)
-- =====================================================================
insert into settings (key, value) values ('rate_confirm_buy_under_pct', '2') on conflict (key) do nothing;

-- 1. A dealer hands bars over only with the customer's 6-digit code, and only to a verified customer.
--    Changing your name, CNIC or date of birth cancels active collections, tells you, and pauses selling and
--    collecting for 24 hours (as a phone number change does).
alter table customers add column identity_changed_at timestamptz;

create or replace function fn_dealer_lookup(p_staff uuid, p_code text) returns jsonb language plpgsql as $$
declare v_s staff; v_r redemptions; v_c customers;
begin
  select * into v_s from staff where id = p_staff and active and role = 'dealer';
  if not found then perform fail('NOT_A_DEALER'); end if;
  select * into v_r from redemptions where code = p_code and status in ('requested', 'ready');
  if not found or v_r.dealer_id <> v_s.dealer_id then
    perform audit('staff:' || p_staff, 'redemption.lookup_failed', 'redemption', null, jsonb_build_object('code_tail', right(p_code, 2)));
    perform fail('CODE_NOT_FOUND');
  end if;
  if v_r.expires_at < now() then perform fail('CODE_EXPIRED'); end if;
  select * into v_c from customers where id = v_r.customer_id;
  if v_c.status <> 'active' then perform fail('ACCOUNT_INACTIVE'); end if;
  if v_c.kyc_status <> 'verified' then perform fail('KYC_REQUIRED'); end if;
  perform audit('staff:' || p_staff, 'redemption.lookup', 'redemption', v_r.id::text, '{}');
  return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'product_id', v_r.product_id, 'units', v_r.units, 'expires_at', v_r.expires_at,
    'customer_name', v_c.name, 'cnic_masked', left(v_c.cnic, 5) || '-•••••••-' || right(v_c.cnic, 1));
end $$;

drop function fn_dealer_handover(uuid, uuid, text[], boolean);
create function fn_dealer_handover(p_staff uuid, p_id uuid, p_serials text[], p_cnic_checked boolean, p_code text) returns redemptions language plpgsql as $$
declare v_r redemptions; v_left int; v_d dealers; v_c customers;
begin
  v_r := dealer_owned(p_staff, p_id);
  -- the same lock as reserving, selling and the ledger check, taken first so they always lock in the same order
  perform pg_advisory_xact_lock(hashtext('redeem:' || v_r.customer_id));
  if coalesce(p_code, '') <> v_r.code then
    perform audit('staff:' || p_staff, 'redemption.handover_wrong_code', 'redemption', p_id::text, '{}');
    perform fail('CODE_NOT_FOUND');
  end if;
  if v_r.status <> 'ready' then perform fail('REDEMPTION_NOT_READY'); end if;
  if v_r.expires_at < now() then perform fail('CODE_EXPIRED'); end if;
  if not coalesce(p_cnic_checked, false) then perform fail('CNIC_NOT_CHECKED'); end if;
  select * into v_c from customers where id = v_r.customer_id;
  if v_c.status <> 'active' then perform fail('ACCOUNT_INACTIVE'); end if;
  if v_c.kyc_status <> 'verified' then perform fail('KYC_REQUIRED'); end if;
  if coalesce(array_length(p_serials, 1), 0) <> v_r.units
     or exists (select 1 from unnest(p_serials) s where coalesce(trim(s), '') = '')
     or (select count(distinct s) from unnest(p_serials) s) <> v_r.units then perform fail('SERIALS_REQUIRED'); end if;
  update dealer_stock set units = units - v_r.units, updated_at = now()
  where dealer_id = v_r.dealer_id and product_id = v_r.product_id and units >= v_r.units returning units into v_left;
  if v_left is null then perform fail('OUT_OF_STOCK'); end if;
  insert into ledger (customer_id, product_id, delta, reason, ref, created_by)
  values (v_r.customer_id, v_r.product_id, -v_r.units, 'redemption', v_r.id::text, 'staff:' || p_staff);
  update redemptions set status = 'completed', completed_at = now(), serials = p_serials, cnic_checked = true, handled_by = p_staff
  where id = p_id returning * into v_r;
  select * into v_d from dealers where id = v_r.dealer_id;
  perform audit('staff:' || p_staff, 'redemption.completed', 'redemption', p_id::text, jsonb_build_object('serials', p_serials));
  perform notify_customer(v_r.customer_id, 'redemption', 'Collected',
    v_r.units || ' × ' || pname(v_r.product_id) || ' collected at ' || v_d.name || '. Serial ' || array_to_string(p_serials, ', ') || '.',
    jsonb_build_object('name', 'code', 'rid', v_r.id), true);
  return v_r;
end $$;

create function fn_identity_changed(p_customer uuid) returns int language plpgsql as $$
declare n int := 0; r redemptions;
begin
  perform pg_advisory_xact_lock(hashtext('redeem:' || p_customer));
  update customers set identity_changed_at = now() where id = p_customer;
  for r in select * from redemptions where customer_id = p_customer and status in ('requested', 'ready') loop
    update redemptions set status = 'cancelled', cancelled_at = now() where id = r.id;
    perform audit('customer:' || p_customer, 'redemption.cancelled', 'redemption', r.id::text, jsonb_build_object('reason', 'identity_changed'));
    n := n + 1;
  end loop;
  perform notify_customer(p_customer, 'security', 'Your identity details changed',
    'Your name, CNIC or date of birth was changed. Verify your identity again to buy, sell or collect.'
    || case when n > 0 then ' Your collections were cancelled for your security.' else '' end
    || ' If this wasn’t you, contact PGBX straight away.', null, false);
  return n;
end $$;

-- 2. Support can't sell to a customer far below market (see fn_chat_confirm below; rate_confirm_buy_under_pct, 2%)
create or replace function fn_chat_confirm(p_staff uuid, p_chat uuid, p_prices jsonb, p_minutes int, p_note text) returns rate_confirmations language plpgsql as $$
declare c rate_chats; r rate_confirmations; l jsonb; v_total numeric := 0; v_price numeric; v_mkt numeric; s rate_snapshots; pr products;
  v_move numeric := coalesce(setting_int('rate_confirm_max_move_pct'), 20) / 100.0; v_minutes int;
  v_max_minutes int := greatest(1, coalesce(setting_int('rate_confirm_minutes')::int, 15));
  v_over numeric := coalesce(setting_int('rate_confirm_sell_over_pct'), 5) / 100.0;
  v_under numeric := coalesce(setting_int('rate_confirm_buy_under_pct'), 2) / 100.0;  -- PGBX selling to a customer below market: a tighter limit   -- PGBX paying a customer more than market: a tighter limit
  v_prices jsonb; g gift_items; v_lock price_locks;
begin
  select * into c from rate_chats where id = p_chat for update;
  if not found then perform fail('CHAT_NOT_FOUND'); end if;
  if c.status = 'closed' then perform fail('CHAT_CLOSED'); end if;
  if jsonb_typeof(p_prices) <> 'object' then perform fail('BAD_RATE'); end if;
  -- the setting is the longest a rate may be held; staff can choose a shorter time
  v_minutes := least(coalesce(p_minutes, v_max_minutes), v_max_minutes);
  if v_minutes < 1 then perform fail('BAD_RATE'); end if;
  -- The guard always applies: against the latest market price, however old (metal prices don't move 20% while a feed is
  -- down). With no market price at all there is nothing to check a typed price against, so nothing can be confirmed.
  select * into s from rate_snapshots order by id desc limit 1;
  if not found then perform fail('RATES_STALE'); end if;
  if c.kind in ('buy_bars', 'sell_bars') then
    v_prices := jsonb_build_object('unit', '{}'::jsonb);
    for l in select * from jsonb_array_elements(c.details -> 'lines') loop
      v_price := (p_prices -> 'unit' ->> (l ->> 'product_id'))::numeric;
      if v_price is null or v_price <= 0 or v_price <> floor(v_price) then perform fail('BAD_RATE'); end if;
      select * into pr from products where id = l ->> 'product_id';
      if s.id is not null then
        v_mkt := case when c.kind = 'buy_bars' then product_price(pr, s)
                      else round((case when pr.metal = 'gold' then s.gold_sell_tola else s.silver_sell_tola end) / 11.664 * pr.grams) end;
        if abs(v_price - v_mkt) > v_mkt * v_move or (c.kind = 'sell_bars' and v_price > v_mkt * (1 + v_over)) or (c.kind = 'buy_bars' and v_price < v_mkt * (1 - v_under)) then perform fail('RATE_OUT_OF_RANGE'); end if;
      end if;
      v_prices := jsonb_set(v_prices, array['unit', l ->> 'product_id'], to_jsonb(v_price::bigint));
      v_total := v_total + v_price * (l ->> 'units')::int;
    end loop;
  elsif c.kind = 'buy_micro' then
    v_price := (p_prices ->> 'price_gram')::numeric;
    if v_price is null or v_price <= 0 or (p_prices ->> 'unit_pkr')::numeric is null or (p_prices ->> 'unit_pkr')::numeric < 1
       or (p_prices ->> 'unit_pkr')::numeric <> floor((p_prices ->> 'unit_pkr')::numeric) then perform fail('BAD_RATE'); end if;
    if abs(v_price - s.gold_buy_tola / 11.664) > s.gold_buy_tola / 11.664 * v_move or v_price < s.gold_buy_tola / 11.664 * (1 - v_under) then perform fail('RATE_OUT_OF_RANGE'); end if;
    v_prices := jsonb_build_object('unit_pkr', (p_prices ->> 'unit_pkr')::bigint, 'price_gram', round(v_price, 2),
      'usd_pkr', coalesce((p_prices ->> 'usd_pkr')::numeric, s.usd_pkr, (p_prices ->> 'unit_pkr')::numeric));
    v_total := (p_prices ->> 'unit_pkr')::bigint * (c.details ->> 'units')::int;
  elsif c.kind = 'sell_micro' then
    v_price := (p_prices ->> 'price_gram')::numeric;
    if v_price is null or v_price <= 0 then perform fail('BAD_RATE'); end if;
    if abs(v_price - s.gold_sell_tola / 11.664) > s.gold_sell_tola / 11.664 * v_move or v_price > s.gold_sell_tola / 11.664 * (1 + v_over) then perform fail('RATE_OUT_OF_RANGE'); end if;
    v_prices := jsonb_build_object('price_gram', round(v_price, 2));
    v_total := greatest(1, floor((c.details ->> 'grams')::numeric * round(v_price, 2)));
  else
    foreach v_price in array array[(p_prices ->> 'metal_pkr')::numeric, (p_prices ->> 'making_pkr')::numeric, (p_prices ->> 'packaging_pkr')::numeric, (p_prices ->> 'delivery_pkr')::numeric] loop
      if v_price is null or v_price < 0 or v_price <> floor(v_price) then perform fail('BAD_RATE'); end if;
    end loop;
    if (p_prices ->> 'metal_pkr')::bigint <= 0 then perform fail('BAD_RATE'); end if;
    select * into g from gift_items where id = c.details ->> 'item';
    if s.id is not null then
      v_mkt := round(g.grams * (case when g.metal = 'gold' then s.gold_buy_tola else s.silver_buy_tola end) / 11.664);
      if abs((p_prices ->> 'metal_pkr')::numeric - v_mkt) > v_mkt * v_move or (p_prices ->> 'metal_pkr')::numeric < v_mkt * (1 - v_under) then perform fail('RATE_OUT_OF_RANGE'); end if;
    end if;
    v_prices := jsonb_build_object('metal_pkr', (p_prices ->> 'metal_pkr')::bigint, 'making_pkr', (p_prices ->> 'making_pkr')::bigint,
      'packaging_pkr', (p_prices ->> 'packaging_pkr')::bigint, 'delivery_pkr', (p_prices ->> 'delivery_pkr')::bigint);
    v_total := (p_prices ->> 'metal_pkr')::bigint + (p_prices ->> 'making_pkr')::bigint + (p_prices ->> 'packaging_pkr')::bigint + (p_prices ->> 'delivery_pkr')::bigint;
  end if;
  update rate_confirmations set status = 'withdrawn' where chat_id = p_chat and status = 'valid';      -- the newest rate replaces any earlier one
  insert into rate_confirmations (chat_id, kind, details, prices, total_pkr, note, confirmed_by, expires_at)
    values (p_chat, c.kind, c.details, v_prices, v_total::bigint, nullif(btrim(coalesce(p_note, '')), ''), p_staff, now() + make_interval(mins => v_minutes))
    returning * into r;
  if c.kind = 'buy_bars' then                                        -- bars are paid through the usual checkout, at a lock holding this rate
    if not exists (select 1 from rate_snapshots) then perform fail('RATES_STALE'); end if;
    insert into price_locks (customer_id, snapshot_id, prices, expires_at, confirmation_id)
      values (c.customer_id, coalesce(s.id, (select max(id) from rate_snapshots)), v_prices -> 'unit', r.expires_at, r.id) returning * into v_lock;
  end if;
  insert into chat_messages (chat_id, sender, staff_id, body, confirmation_id)
    values (p_chat, 'staff', p_staff, 'Final rate confirmed: ' || rs(v_total::bigint) || ' for ' || c.summary || '. Valid for ' || v_minutes || ' minutes (until '
      || to_char(r.expires_at at time zone 'Asia/Karachi', 'HH24:MI') || ' Pakistan time).' || coalesce(' ' || r.note, ''), r.id);
  update rate_chats set status = 'confirmed', last_message_at = now(), last_staff_at = now(), staff_read_at = now(), assigned_to = coalesce(assigned_to, p_staff) where id = p_chat;
  perform notify_customer(c.customer_id, 'chat', 'Final rate confirmed', rs(v_total::bigint) || ' for ' || c.summary || '. Valid for ' || v_minutes || ' minutes.',
    jsonb_build_object('name', 'chat', 'id', p_chat), true);
  perform audit('staff:' || p_staff, 'chat.rate_confirmed', 'chat', c.ref, jsonb_build_object('total', v_total, 'prices', v_prices, 'minutes', v_minutes));
  return r;
end $$;

-- 3. Limits counted per customer can't be overrun by parallel requests: open chats, price alerts, chat file allowance
create function fn_chat_open_locked(p_customer uuid, p_kind text, p_details jsonb, p_indicative bigint) returns rate_chats language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('chat:' || p_customer));
  return fn_chat_open(p_customer, p_kind, p_details, p_indicative);
end $$;

create function fn_add_alert(p_customer uuid, p_metal text, p_dir text, p_target bigint) returns price_alerts language plpgsql as $$
declare a price_alerts;
begin
  perform pg_advisory_xact_lock(hashtext('alerts:' || p_customer));
  if (select count(*) from price_alerts where customer_id = p_customer and active) >= 20 then perform fail('TOO_MANY_ALERTS'); end if;
  insert into price_alerts (customer_id, metal, dir, target_pkr) values (p_customer, p_metal, p_dir, p_target) returning * into a;
  return a;
end $$;

create function fn_store_attachment(p_customer uuid, p_chat uuid, p_uploader text, p_name text, p_mime text, p_size int, p_b64 text,
  p_day_bytes bigint, p_per_chat int) returns uuid language plpgsql as $$
declare v_day bigint; v_here int; v_id uuid;
begin
  if p_customer is not null then
    perform pg_advisory_xact_lock(hashtext('files:' || p_customer));
    select coalesce(sum(a.size) filter (where a.created_at > now() - interval '24 hours'), 0), count(*) filter (where a.chat_id = p_chat)
      into v_day, v_here from chat_attachments a join rate_chats c on c.id = a.chat_id where c.customer_id = p_customer;
    if v_here >= p_per_chat or v_day + p_size > p_day_bytes then perform fail('TOO_MANY_FILES'); end if;
  end if;
  insert into chat_attachments (chat_id, uploaded_by, name, mime, size, data) values (p_chat, p_uploader, p_name, p_mime, p_size, decode(p_b64, 'base64'))
    returning id into v_id;
  return v_id;
end $$;

-- 4. Refunding a flagged order goes through the refunds queue like every other refund: the customer is told when the
--    money is actually sent (with its reference), not when operations decide.
create or replace function fn_resolve_order(p_staff uuid, p_order uuid, p_action text, p_note text) returns orders language plpgsql as $$
declare v_order orders; p payments;
begin
  select * into v_order from orders where id = p_order for update;
  if not found then perform fail('ORDER_NOT_FOUND'); end if;
  if v_order.status <> 'flagged' then perform fail('ORDER_NOT_FLAGGED'); end if;
  if p_action = 'credit' then
    perform credit_order(v_order, 'staff:' || p_staff);
    perform notify_customer(v_order.customer_id, 'purchase', 'Order completed', v_order.receipt_no || ' is now in your wallet.',
      jsonb_build_object('name', 'receipt', 'oid', v_order.id), true);
  elsif p_action = 'refund' then
    update orders set status = 'refunded' where id = p_order;
    for p in select * from payments where order_id = p_order and status = 'succeeded' loop
      perform record_refund('order', p_order, v_order.receipt_no, v_order.customer_id, p.provider, p.provider_ref, p.amount_pkr,
        'Order refunded by operations' || coalesce(': ' || nullif(btrim(p_note), ''), ''));
    end loop;
    perform notify_customer(v_order.customer_id, 'purchase', 'Order will be refunded', coalesce(v_order.receipt_no, 'Your order') || ' will be refunded to your payment method. We’ll tell you when it’s sent.',
      jsonb_build_object('name', 'receipt', 'oid', v_order.id), true);
  else
    perform fail('BAD_ACTION');
  end if;
  update orders set resolved_at = now(), resolved_by = 'staff:' || p_staff, note = coalesce(p_note, note) where id = p_order returning * into v_order;
  perform audit('staff:' || p_staff, 'order.resolved', 'order', p_order::text, jsonb_build_object('action', p_action, 'note', p_note));
  return v_order;
end $$;

-- 5. Phone notifications are claimed before sending, so two server instances never send the same one twice
create function fn_claim_push(p_limit int) returns setof notifications language sql as $$
  update notifications set pushed_at = now()
  where id in (select id from notifications where push and pushed_at is null and created_at > now() - interval '2 days' order by id limit p_limit for update skip locked)
  returning *
$$;

-- 6. Addresses each staff member signed in from (hashed, 30 days): guesses from elsewhere can't lock them out
create table staff_known_addresses (
  staff_id uuid not null references staff(id),
  address_hash text not null,
  last_at timestamptz not null default now(),
  primary key (staff_id, address_hash)
);
alter table staff_known_addresses enable row level security;

-- ---------- hardening, as for every function ----------
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
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end $$;
