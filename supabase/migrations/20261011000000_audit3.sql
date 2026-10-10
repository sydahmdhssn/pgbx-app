-- Audit fixes (2026-10-11)
--  1. Bars can't be sold back and collected at the same time: selling takes the collection lock too, and no ledger entry
--     may take a customer's holding of a product below zero (checked under the same lock).
--  2. The rate guard always applies (against the latest market price, however old); PGBX can't confirm paying a customer
--     more than rate_confirm_sell_over_pct above market; a rate is held for at most rate_confirm_minutes.
--  3. The closed-account purge also removes bank accounts from bar sales and staff notes from confirmed rates.

insert into settings (key, value) values ('rate_confirm_sell_over_pct', '5') on conflict (key) do nothing;

-- ---------- 1. holdings never go below zero ----------
create function ledger_not_negative() returns trigger language plpgsql as $$
begin
  if new.delta < 0 then
    perform pg_advisory_xact_lock(hashtext('redeem:' || new.customer_id));
    if holdings_of(new.customer_id, new.product_id) + new.delta < 0 then perform fail('INSUFFICIENT_HOLDINGS'); end if;
  end if;
  return new;
end $$;
create trigger ledger_not_negative before insert on ledger for each row execute function ledger_not_negative();

create or replace function fn_sell_bars(p_customer uuid, p_confirmation uuid, p_iban text, p_key text) returns bar_sales language plpgsql as $$
declare b bar_sales; r rate_confirmations; l jsonb; v_lines jsonb := '[]'; v_ref text;
begin
  if coalesce(p_key, '') = '' then perform fail('BAD_KEY'); end if;
  perform require_active_customer(p_customer, true);
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));
  perform pg_advisory_xact_lock(hashtext('redeem:' || p_customer));      -- the same lock as reserving for collection: bars leave one way at a time
  select * into b from bar_sales where customer_id = p_customer and idempotency_key = p_key;
  if found then return b; end if;
  if coalesce(p_iban, '') !~ '^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$' or not iban_ok(p_iban) then perform fail('BAD_IBAN'); end if;
  r := take_confirmation(p_customer, p_confirmation, 'sell_bars');
  for l in select * from jsonb_array_elements(r.details -> 'lines') loop
    if free_units(p_customer, l ->> 'product_id') < (l ->> 'units')::int then perform fail('INSUFFICIENT_HOLDINGS'); end if;
    v_lines := v_lines || jsonb_build_object('product_id', l ->> 'product_id', 'units', (l ->> 'units')::int, 'unit_price_pkr', (r.prices -> 'unit' ->> (l ->> 'product_id'))::bigint);
  end loop;
  v_ref := 'PGBX-BS-' || to_char(now() at time zone 'Asia/Karachi', 'YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
  insert into bar_sales (ref, customer_id, confirmation_id, lines, total_pkr, payout_to, idempotency_key)
    values (v_ref, p_customer, r.id, v_lines, r.total_pkr, p_iban, p_key) returning * into b;
  insert into ledger (customer_id, product_id, delta, reason, ref, unit_price_pkr, created_by)
    select p_customer, x ->> 'product_id', -((x ->> 'units')::int), 'sale', b.ref, (x ->> 'unit_price_pkr')::bigint, 'customer:' || p_customer from jsonb_array_elements(v_lines) x;
  perform confirmation_used(r.id, b.ref);
  perform audit('customer:' || p_customer, 'bars.sold', 'bar_sale', b.ref, jsonb_build_object('lines', v_lines, 'total', b.total_pkr));
  perform notify_customer(p_customer, 'purchase', 'Bars sold to PGBX', rs(b.total_pkr) || ' · ' || b.ref || '. PGBX will pay it to your bank account ending ' || right(p_iban, 4) || '.',
    jsonb_build_object('name', 'wallet'), false);
  return b;
end $$;

-- ---------- 2. confirming a rate ----------
create or replace function fn_chat_confirm(p_staff uuid, p_chat uuid, p_prices jsonb, p_minutes int, p_note text) returns rate_confirmations language plpgsql as $$
declare c rate_chats; r rate_confirmations; l jsonb; v_total numeric := 0; v_price numeric; v_mkt numeric; s rate_snapshots; pr products;
  v_move numeric := coalesce(setting_int('rate_confirm_max_move_pct'), 20) / 100.0; v_minutes int;
  v_max_minutes int := greatest(1, coalesce(setting_int('rate_confirm_minutes')::int, 15));
  v_over numeric := coalesce(setting_int('rate_confirm_sell_over_pct'), 5) / 100.0;   -- PGBX paying a customer more than market: a tighter limit
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
        if abs(v_price - v_mkt) > v_mkt * v_move or (c.kind = 'sell_bars' and v_price > v_mkt * (1 + v_over)) then perform fail('RATE_OUT_OF_RANGE'); end if;
      end if;
      v_prices := jsonb_set(v_prices, array['unit', l ->> 'product_id'], to_jsonb(v_price::bigint));
      v_total := v_total + v_price * (l ->> 'units')::int;
    end loop;
  elsif c.kind = 'buy_micro' then
    v_price := (p_prices ->> 'price_gram')::numeric;
    if v_price is null or v_price <= 0 or (p_prices ->> 'unit_pkr')::numeric is null or (p_prices ->> 'unit_pkr')::numeric < 1
       or (p_prices ->> 'unit_pkr')::numeric <> floor((p_prices ->> 'unit_pkr')::numeric) then perform fail('BAD_RATE'); end if;
    if s.id is not null and abs(v_price - s.gold_buy_tola / 11.664) > s.gold_buy_tola / 11.664 * v_move then perform fail('RATE_OUT_OF_RANGE'); end if;
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
      if abs((p_prices ->> 'metal_pkr')::numeric - v_mkt) > v_mkt * v_move then perform fail('RATE_OUT_OF_RANGE'); end if;
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

-- ---------- 3. purge ----------
create or replace function chat_append_only_sale() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY: bar sales cannot be deleted'; end if;
  -- the purge may remove the bank account of a sale that has been paid
  if old.status = 'paid_out' and new.payout_to = '[removed]' and (to_jsonb(new) - 'payout_to') = (to_jsonb(old) - 'payout_to') then return new; end if;
  if (to_jsonb(new) - array['status', 'payout_ref', 'paid_out_at', 'paid_out_by']) <> (to_jsonb(old) - array['status', 'payout_ref', 'paid_out_at', 'paid_out_by']) then
    raise exception 'APPEND_ONLY: a bar sale cannot be changed';
  end if;
  return new;
end $$;
create or replace function chat_append_only() returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'APPEND_ONLY: % rows cannot be deleted', tg_table_name; end if;
  if tg_table_name = 'chat_messages' then
    if new.body = '[removed]' and (to_jsonb(new) - 'body') = (to_jsonb(old) - 'body') then return new; end if;
    raise exception 'APPEND_ONLY: chat messages cannot be changed';
  end if;
  -- the purge may remove a staff note (free text about the customer)
  if new.note is null and old.note is not null and (to_jsonb(new) - 'note') = (to_jsonb(old) - 'note') then return new; end if;
  if (to_jsonb(new) - array['status', 'used_at', 'used_ref']) <> (to_jsonb(old) - array['status', 'used_at', 'used_ref']) then
    raise exception 'APPEND_ONLY: a confirmed rate cannot be changed';
  end if;
  return new;
end $$;
create or replace function fn_purge_closed() returns int language plpgsql as $$
declare n int;
begin
  n := fn_purge_closed_base();
  update chat_messages m set body = '[removed]' from rate_chats c, customers u
    where c.id = m.chat_id and u.id = c.customer_id and u.purged_at is not null and m.body <> '[removed]' and m.sender <> 'system';
  update chat_attachments a set data = null, name = '[removed]' from rate_chats c, customers u
    where c.id = a.chat_id and u.id = c.customer_id and u.purged_at is not null and a.data is not null;
  update rate_confirmations r set note = null from rate_chats c, customers u
    where c.id = r.chat_id and u.id = c.customer_id and u.purged_at is not null and r.note is not null;
  update bar_sales b set payout_to = '[removed]' from customers u
    where u.id = b.customer_id and u.purged_at is not null and b.status = 'paid_out' and b.payout_to <> '[removed]';
  return n;
end $$;

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
