-- PGBX rate chat: prices in the app are indicative. Before any purchase or sale the customer opens a private chat
-- about that exact request (what, how much); PGBX support confirms the final rate there, and the order can only be
-- placed at a confirmed, unexpired rate, once. Covers buying bars, selling bars back, $1 gold buys and sales, and
-- gift orders.
--
-- Privacy: a chat belongs to one customer. The API (the only database client; row-level security has no policies)
-- shows a chat only to that customer, and to staff with the admin or support role. Messages can't be edited or
-- deleted; attachments (payment screenshots, max ~2 MB) live in the database and are served only through those
-- routes.

-- ---------- settings ----------
insert into settings (key, value) values
  ('rate_chat_required', 'true'),          -- orders need a rate confirmed by support in the chat
  ('rate_confirm_minutes', '15'),          -- how long a confirmed rate can be used
  ('rate_confirm_max_move_pct', '20');     -- a confirmed price more than this % from the market is refused (typo guard)
create function rate_chat_on() returns boolean language sql stable as $$
  select coalesce((setting('rate_chat_required') #>> '{}')::boolean, true)
$$;

-- ---------- support staff ----------
alter table staff drop constraint staff_role_check;
alter table staff add constraint staff_role_check check (role in ('admin', 'ops', 'dealer', 'support'));

-- ---------- notifications and the ledger ----------
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('purchase', 'redemption', 'security', 'account', 'alert', 'service', 'chat'));
alter table ledger drop constraint ledger_reason_check;
alter table ledger add constraint ledger_reason_check check (reason in ('purchase', 'redemption', 'adjustment', 'sale'));

-- ---------- chats ----------
-- kind and details describe what the customer wants:
--   buy_bars, sell_bars  {"lines": [{"product_id": "g-1g", "units": 2}, ...]}
--   buy_micro            {"units": 5}            ($1 transactions)
--   sell_micro           {"grams": 0.0123}
--   gift                 {"item": "gg-1g", "shape": "coin", "design": "eid", "engraving": "", "packaging": "premium"}
create table rate_chats (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  customer_id uuid not null references customers(id),
  kind text not null check (kind in ('buy_bars', 'sell_bars', 'buy_micro', 'sell_micro', 'gift')),
  details jsonb not null,
  summary text not null,
  indicative_pkr bigint check (indicative_pkr is null or indicative_pkr >= 0),
  status text not null default 'open' check (status in ('open', 'confirmed', 'completed', 'closed')),
  assigned_to uuid references staff(id),
  last_message_at timestamptz not null default now(),
  last_customer_at timestamptz,
  last_staff_at timestamptz,
  customer_read_at timestamptz,
  staff_read_at timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text
);
create index rate_chats_customer on rate_chats (customer_id, created_at desc);
create index rate_chats_inbox on rate_chats (status, last_message_at desc);

create table chat_attachments (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references rate_chats(id),
  uploaded_by text not null,
  name text not null,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size int not null check (size between 1 and 2621440),
  data bytea,                                                  -- null once removed by the retention purge
  created_at timestamptz not null default now()
);
create index on chat_attachments (chat_id);

create table rate_confirmations (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references rate_chats(id),
  kind text not null,
  details jsonb not null,                                      -- the request the rate applies to (copied)
  prices jsonb not null,                                       -- see fn_chat_confirm
  total_pkr bigint not null check (total_pkr > 0),
  note text,
  confirmed_by uuid not null references staff(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'valid' check (status in ('valid', 'used', 'withdrawn')),
  used_at timestamptz,
  used_ref text
);
create unique index rate_confirmations_one_valid on rate_confirmations (chat_id) where status = 'valid';

create table chat_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references rate_chats(id),
  sender text not null check (sender in ('customer', 'staff', 'system')),
  staff_id uuid references staff(id),
  body text not null check (length(body) <= 2000),
  attachment_id uuid references chat_attachments(id),
  confirmation_id uuid references rate_confirmations(id),
  created_at timestamptz not null default now(),
  check ((sender = 'staff') = (staff_id is not null))
);
create index on chat_messages (chat_id, id);

-- A confirmed rate creates a price lock for bar purchases; the order must use that lock
alter table price_locks add column confirmation_id uuid references rate_confirmations(id);

-- Messages are a record: nothing can be edited or deleted, except the retention purge blanking the text.
-- Confirmations: the rate itself can never change, only its status.
create function chat_append_only() returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'APPEND_ONLY: % rows cannot be deleted', tg_table_name; end if;
  if tg_table_name = 'chat_messages' then
    if new.body = '[removed]' and (to_jsonb(new) - 'body') = (to_jsonb(old) - 'body') then return new; end if;
    raise exception 'APPEND_ONLY: chat messages cannot be changed';
  end if;
  if (to_jsonb(new) - array['status', 'used_at', 'used_ref']) <> (to_jsonb(old) - array['status', 'used_at', 'used_ref']) then
    raise exception 'APPEND_ONLY: a confirmed rate cannot be changed';
  end if;
  return new;
end $$;
create trigger chat_messages_append_only before update or delete on chat_messages for each row execute function chat_append_only();
create trigger chat_messages_no_truncate before truncate on chat_messages for each statement execute function chat_append_only();
create trigger rate_confirmations_append_only before update or delete on rate_confirmations for each row execute function chat_append_only();
create trigger rate_confirmations_no_truncate before truncate on rate_confirmations for each statement execute function chat_append_only();

-- ---------- helpers ----------
-- Lines as a canonical list, so two requests for the same bars compare equal whatever their order
create function norm_lines(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('product_id', e ->> 'product_id', 'units', (e ->> 'units')::int) order by e ->> 'product_id'), '[]')
  from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]' end) e
$$;
create function chat_ref() returns text language plpgsql as $$
declare v text;
begin
  loop
    v := 'PGBX-C-' || to_char(now() at time zone 'Asia/Karachi', 'YYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    exit when not exists (select 1 from rate_chats where ref = v);
  end loop;
  return v;
end $$;
-- Bars in a request: valid products, whole units, no duplicate lines
create function check_lines(p jsonb, p_buy boolean) returns void language plpgsql as $$
declare l jsonb; n int := 0;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 or jsonb_array_length(p) > 20 then perform fail('NO_PRODUCTS'); end if;
  for l in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(l) <> 'object' or not exists (select 1 from products where id = l ->> 'product_id' and (active or not p_buy)) then perform fail('UNKNOWN_PRODUCT'); end if;
    if jsonb_typeof(l -> 'units') <> 'number' or (l ->> 'units')::numeric <> floor((l ->> 'units')::numeric)
       or (l ->> 'units')::numeric < 1 or (l ->> 'units')::numeric > 1000 then perform fail('BAD_UNITS'); end if;
    if (select count(*) from jsonb_array_elements(p) y where y ->> 'product_id' = l ->> 'product_id') > 1 then perform fail('DUPLICATE_LINE'); end if;
    n := n + (l ->> 'units')::int;
  end loop;
  if p_buy and n > setting_int('max_units_per_order') then perform fail('ORDER_LIMIT'); end if;
end $$;
-- Bars a customer can sell or collect: held minus reserved for collection
create function free_units(p_customer uuid, p_product text) returns int language sql stable as $$
  select holdings_of(p_customer, p_product) - reserved_of(p_customer, p_product)
$$;
-- One line describing a request, for chat lists and notifications
create function chat_summary(p_kind text, p jsonb) returns text language sql stable as $$
  select case p_kind
    when 'buy_bars' then 'Buy ' || (select string_agg((e ->> 'units') || ' × ' || pname(e ->> 'product_id'), ', ') from jsonb_array_elements(p -> 'lines') e)
    when 'sell_bars' then 'Sell back ' || (select string_agg((e ->> 'units') || ' × ' || pname(e ->> 'product_id'), ', ') from jsonb_array_elements(p -> 'lines') e)
    when 'buy_micro' then 'Buy $' || (p ->> 'units') || ' of gold ($1 gold)'
    when 'sell_micro' then 'Sell ' || to_char((p ->> 'grams')::numeric, 'FM990.0000') || ' g of $1 gold'
    else 'Gift: ' || coalesce((select label || ' ' || metal from gift_items where id = p ->> 'item'), p ->> 'item') || ' ' || (p ->> 'shape')
      || case when coalesce(p ->> 'engraving', '') <> '' then ', engraved' else '' end end
$$;

-- ---------- opening a chat ----------
create function fn_chat_open(p_customer uuid, p_kind text, p_details jsonb, p_indicative bigint) returns rate_chats language plpgsql as $$
declare c rate_chats; d jsonb; l jsonb; i gift_items;
begin
  perform require_active_customer(p_customer, false);
  if (select count(*) from rate_chats where customer_id = p_customer and status in ('open', 'confirmed')) >= 5 then perform fail('TOO_MANY_CHATS'); end if;
  if jsonb_typeof(p_details) <> 'object' then perform fail('BAD_REQUEST'); end if;
  if p_kind in ('buy_bars', 'sell_bars') then
    perform check_lines(p_details -> 'lines', p_kind = 'buy_bars');
    d := jsonb_build_object('lines', norm_lines(p_details -> 'lines'));
    if p_kind = 'sell_bars' then
      for l in select * from jsonb_array_elements(d -> 'lines') loop
        if free_units(p_customer, l ->> 'product_id') < (l ->> 'units')::int then perform fail('INSUFFICIENT_HOLDINGS'); end if;
      end loop;
    end if;
  elsif p_kind = 'buy_micro' then
    if jsonb_typeof(p_details -> 'units') <> 'number' or (p_details ->> 'units')::numeric <> floor((p_details ->> 'units')::numeric)
       or (p_details ->> 'units')::int < 1 or (p_details ->> 'units')::int > setting_int('micro_max_units') then perform fail('BAD_UNITS'); end if;
    d := jsonb_build_object('units', (p_details ->> 'units')::int);
  elsif p_kind = 'sell_micro' then
    if jsonb_typeof(p_details -> 'grams') <> 'number' or (p_details ->> 'grams')::numeric <= 0 then perform fail('BAD_GRAMS'); end if;
    if round((p_details ->> 'grams')::numeric, 6) > micro_grams(p_customer) then perform fail('INSUFFICIENT_GOLD'); end if;
    d := jsonb_build_object('grams', round((p_details ->> 'grams')::numeric, 6));
  elsif p_kind = 'gift' then
    select * into i from gift_items where id = p_details ->> 'item' and active;
    if not found then perform fail('UNKNOWN_PRODUCT'); end if;
    if not ((p_details ->> 'shape') = any(i.shapes)) then perform fail('BAD_SHAPE'); end if;
    if coalesce(p_details ->> 'design', '') not in ('plain', 'eid', 'wedding', 'birthday', 'newborn', 'graduation') then perform fail('BAD_DESIGN'); end if;
    if coalesce(p_details ->> 'packaging', '') not in ('standard', 'premium') then perform fail('BAD_PACKAGING'); end if;
    if length(coalesce(p_details ->> 'engraving', '')) > 24 then perform fail('ENGRAVING_TOO_LONG'); end if;
    d := jsonb_build_object('item', i.id, 'shape', p_details ->> 'shape', 'design', p_details ->> 'design', 'engraving', coalesce(p_details ->> 'engraving', ''), 'packaging', p_details ->> 'packaging');
  else
    perform fail('BAD_REQUEST');
  end if;
  insert into rate_chats (ref, customer_id, kind, details, summary, indicative_pkr, last_customer_at, customer_read_at)
    values (chat_ref(), p_customer, p_kind, d, chat_summary(p_kind, d), case when p_indicative > 0 then p_indicative end, now(), now()) returning * into c;
  insert into chat_messages (chat_id, sender, body)
    values (c.id, 'system', c.summary || case when c.indicative_pkr is not null then ' · app price ' || rs(c.indicative_pkr) || ' (indicative)' else '' end
      || '. PGBX support will confirm the final rate here.');
  perform audit('customer:' || p_customer, 'chat.opened', 'chat', c.ref, jsonb_build_object('kind', p_kind, 'details', d));
  return c;
end $$;

-- ---------- messages ----------
-- p_sender 'customer' (p_customer must own the chat) or 'staff' (p_staff)
create function fn_chat_post(p_chat uuid, p_sender text, p_customer uuid, p_staff uuid, p_body text, p_attachment uuid default null)
returns chat_messages language plpgsql as $$
declare c rate_chats; m chat_messages; v_body text := btrim(coalesce(p_body, ''));
begin
  select * into c from rate_chats where id = p_chat for update;
  if not found or (p_sender = 'customer' and c.customer_id is distinct from p_customer) then perform fail('CHAT_NOT_FOUND'); end if;
  if c.status = 'closed' then perform fail('CHAT_CLOSED'); end if;
  if p_sender = 'customer' then perform require_active_customer(p_customer, false); end if;
  if v_body = '' and p_attachment is null then perform fail('EMPTY_MESSAGE'); end if;
  if length(v_body) > 2000 then perform fail('MESSAGE_TOO_LONG'); end if;
  if p_attachment is not null and not exists (select 1 from chat_attachments where id = p_attachment and chat_id = p_chat) then perform fail('CHAT_NOT_FOUND'); end if;
  insert into chat_messages (chat_id, sender, staff_id, body, attachment_id)
    values (p_chat, p_sender, case when p_sender = 'staff' then p_staff end, v_body, p_attachment) returning * into m;
  if p_sender = 'customer' then
    update rate_chats set last_message_at = now(), last_customer_at = now(), customer_read_at = now(), status = case when status = 'completed' then 'open' else status end where id = p_chat;
  else
    update rate_chats set last_message_at = now(), last_staff_at = now(), staff_read_at = now(), assigned_to = coalesce(assigned_to, p_staff),
      status = case when status = 'completed' then 'open' else status end where id = p_chat;
    -- one unread notice per chat, however many replies arrive before the customer looks
    if not exists (select 1 from notifications where customer_id = c.customer_id and kind = 'chat' and read_at is null and link ->> 'id' = p_chat::text) then
      perform notify_customer(c.customer_id, 'chat', 'PGBX support replied', left(case when v_body = '' then 'Sent you a file.' else v_body end, 140),
        jsonb_build_object('name', 'chat', 'id', p_chat), true);
    end if;
  end if;
  return m;
end $$;

-- ---------- confirming the rate (support) ----------
-- p_prices by kind:
--   buy_bars, sell_bars  {"unit": {"g-1g": 37950, ...}}         price per bar for every line
--   buy_micro            {"unit_pkr": 280, "price_gram": 37400.5, "usd_pkr": 280.1}
--   sell_micro           {"price_gram": 36900}
--   gift                 {"metal_pkr": .., "making_pkr": .., "packaging_pkr": .., "delivery_pkr": ..}
-- Prices are checked against the latest market snapshot (when fresh) so a mistyped zero can't be confirmed.
create function fn_chat_confirm(p_staff uuid, p_chat uuid, p_prices jsonb, p_minutes int, p_note text) returns rate_confirmations language plpgsql as $$
declare c rate_chats; r rate_confirmations; l jsonb; v_total numeric := 0; v_price numeric; v_mkt numeric; s rate_snapshots; pr products;
  v_move numeric := coalesce(setting_int('rate_confirm_max_move_pct'), 20) / 100.0; v_minutes int; v_prices jsonb; g gift_items; v_lock price_locks;
begin
  select * into c from rate_chats where id = p_chat for update;
  if not found then perform fail('CHAT_NOT_FOUND'); end if;
  if c.status = 'closed' then perform fail('CHAT_CLOSED'); end if;
  if jsonb_typeof(p_prices) <> 'object' then perform fail('BAD_RATE'); end if;
  v_minutes := coalesce(p_minutes, setting_int('rate_confirm_minutes')::int, 15);
  if v_minutes < 1 or v_minutes > 240 then perform fail('BAD_RATE'); end if;
  select * into s from rate_snapshots order by id desc limit 1;
  if found and s.fetched_at < now() - interval '1 hour' then s := null; end if;     -- only a recent market price is a fair guard
  if c.kind in ('buy_bars', 'sell_bars') then
    v_prices := jsonb_build_object('unit', '{}'::jsonb);
    for l in select * from jsonb_array_elements(c.details -> 'lines') loop
      v_price := (p_prices -> 'unit' ->> (l ->> 'product_id'))::numeric;
      if v_price is null or v_price <= 0 or v_price <> floor(v_price) then perform fail('BAD_RATE'); end if;
      select * into pr from products where id = l ->> 'product_id';
      if s.id is not null then
        v_mkt := case when c.kind = 'buy_bars' then product_price(pr, s)
                      else round((case when pr.metal = 'gold' then s.gold_sell_tola else s.silver_sell_tola end) / 11.664 * pr.grams) end;
        if abs(v_price - v_mkt) > v_mkt * v_move then perform fail('RATE_OUT_OF_RANGE'); end if;
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
    if s.id is not null and abs(v_price - s.gold_sell_tola / 11.664) > s.gold_sell_tola / 11.664 * v_move then perform fail('RATE_OUT_OF_RANGE'); end if;
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

-- Closing (support, or the customer ending their own request). A closed chat can still be read; its rate can't be used.
create function fn_chat_close(p_chat uuid, p_actor text, p_customer uuid, p_note text) returns rate_chats language plpgsql as $$
declare c rate_chats;
begin
  select * into c from rate_chats where id = p_chat for update;
  if not found or (p_customer is not null and c.customer_id <> p_customer) then perform fail('CHAT_NOT_FOUND'); end if;
  if c.status = 'closed' then return c; end if;
  update rate_confirmations set status = 'withdrawn' where chat_id = p_chat and status = 'valid';
  insert into chat_messages (chat_id, sender, body) values (p_chat, 'system',
    case when p_customer is not null then 'You closed this request.' else 'PGBX support closed this request.' end || coalesce(' ' || nullif(btrim(coalesce(p_note, '')), ''), ''));
  update rate_chats set status = 'closed', closed_at = now(), closed_by = p_actor, last_message_at = now() where id = p_chat returning * into c;
  perform audit(p_actor, 'chat.closed', 'chat', c.ref, '{}');
  return c;
end $$;

-- ---------- using a confirmed rate ----------
-- Locks and checks the customer's confirmation for this kind of request; fails with a clear reason otherwise.
create function take_confirmation(p_customer uuid, p_id uuid, p_kind text) returns rate_confirmations language plpgsql as $$
declare r rate_confirmations; c rate_chats;
begin
  if p_id is null then perform fail('RATE_NOT_CONFIRMED'); end if;
  select * into r from rate_confirmations where id = p_id for update;
  if not found then perform fail('RATE_NOT_CONFIRMED'); end if;
  select * into c from rate_chats where id = r.chat_id;
  if c.customer_id <> p_customer or r.kind <> p_kind then perform fail('RATE_NOT_CONFIRMED'); end if;
  if r.status = 'used' then perform fail('RATE_USED'); end if;
  if r.status <> 'valid' or c.status = 'closed' then perform fail('RATE_NOT_CONFIRMED'); end if;
  if r.expires_at < now() then perform fail('RATE_EXPIRED'); end if;
  return r;
end $$;
create function confirmation_used(p_id uuid, p_ref text) returns void language plpgsql as $$
declare r rate_confirmations;
begin
  update rate_confirmations set status = 'used', used_at = now(), used_ref = p_ref where id = p_id returning * into r;
  insert into chat_messages (chat_id, sender, body, confirmation_id) values (r.chat_id, 'system', 'Placed at the confirmed rate · ' || p_ref || '.', r.id);
  update rate_chats set status = 'completed', last_message_at = now() where id = r.chat_id;
end $$;

-- Bar orders: when the chat rule is on, only a lock created by a confirmed rate can be paid, for exactly the bars
-- that were confirmed.
create or replace function fn_place_order(p_customer uuid, p_lock uuid, p_lines jsonb, p_method text, p_key text) returns orders language plpgsql as $$
declare
  v_order orders; v_lock price_locks; v_total bigint := 0; v_units int := 0; v_spent bigint; l jsonb; v_price bigint; r rate_confirmations;
begin
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));         -- one purchase decision at a time per customer (limits, idempotency)
  select * into v_order from orders where customer_id = p_customer and idempotency_key = p_key;
  if found then return v_order; end if;                                  -- repeat of the same request (Rule 2)
  perform require_active_customer(p_customer, true);
  select * into v_lock from price_locks where id = p_lock and customer_id = p_customer;
  if not found then perform fail('LOCK_NOT_FOUND'); end if;
  if rate_chat_on() or v_lock.confirmation_id is not null then
    r := take_confirmation(p_customer, v_lock.confirmation_id, 'buy_bars');
    if norm_lines(p_lines) <> r.details -> 'lines' then perform fail('RATE_MISMATCH'); end if;
  end if;
  if v_lock.expires_at < now() then perform fail('LOCK_EXPIRED'); end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then perform fail('NO_PRODUCTS'); end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_price := (v_lock.prices ->> (l ->> 'product_id'))::bigint;
    if v_price is null then perform fail('PRODUCT_NOT_LOCKED'); end if;
    if jsonb_typeof(l -> 'units') <> 'number' or (l ->> 'units')::numeric <> floor((l ->> 'units')::numeric)
       or (l ->> 'units')::numeric < 1 or (l ->> 'units')::numeric > 1000 then perform fail('BAD_UNITS'); end if;
    if (select count(*) from jsonb_array_elements(p_lines) y where y ->> 'product_id' = l ->> 'product_id') > 1 then perform fail('DUPLICATE_LINE'); end if;
    v_units := v_units + (l ->> 'units')::int;
    v_total := v_total + v_price * (l ->> 'units')::int;
  end loop;
  if v_units > setting_int('max_units_per_order') then perform fail('ORDER_LIMIT'); end if;
  if setting_int('min_purchase_pkr') is not null and v_total < setting_int('min_purchase_pkr') then perform fail('MIN_PURCHASE'); end if;
  v_spent := spent_today(p_customer);                                  -- purchases and gift orders, Pakistan day
  if v_spent + v_total > setting_int('daily_limit_pkr') then perform fail('DAILY_LIMIT'); end if;
  insert into orders (customer_id, idempotency_key, lock_id, method, total_pkr, receipt_no)
  values (p_customer, p_key, p_lock, p_method, v_total, 'PGBX-R-' || to_char(now() at time zone 'Asia/Karachi', 'YYMMDD') || '-' || lpad(nextval('receipt_seq')::text, 6, '0'))
  returning * into v_order;
  insert into order_lines (order_id, product_id, units, unit_price_pkr)
  select v_order.id, x ->> 'product_id', (x ->> 'units')::int, (v_lock.prices ->> (x ->> 'product_id'))::bigint
  from jsonb_array_elements(p_lines) x;
  if r.id is not null then perform confirmation_used(r.id, v_order.receipt_no); end if;
  perform audit('customer:' || p_customer, 'order.placed', 'order', v_order.id::text, jsonb_build_object('total', v_total, 'lines', p_lines, 'confirmation', r.id));
  return v_order;
end $$;

-- $1 gold purchases at the confirmed price per $1 and per gram
drop function fn_micro_buy(uuid, int, text);
create function fn_micro_buy(p_customer uuid, p_units int, p_key text, p_confirmation uuid default null) returns micro_orders language plpgsql as $$
declare o micro_orders; s rate_snapshots; v_unit bigint; v_price numeric; v_grams numeric; v_usd_pkr numeric; i int; r rate_confirmations;
begin
  perform require_active_customer(p_customer, true);
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));
  select * into o from micro_orders where customer_id = p_customer and idempotency_key = p_key;
  if found then return o; end if;                                  -- the same request again: same order
  if p_units is null or p_units < 1 or p_units > setting_int('micro_max_units') then perform fail('BAD_UNITS'); end if;
  if rate_chat_on() or p_confirmation is not null then
    r := take_confirmation(p_customer, p_confirmation, 'buy_micro');
    if (r.details ->> 'units')::int <> p_units then perform fail('RATE_MISMATCH'); end if;
    v_unit := (r.prices ->> 'unit_pkr')::bigint; v_price := (r.prices ->> 'price_gram')::numeric; v_usd_pkr := (r.prices ->> 'usd_pkr')::numeric;
  else
    s := micro_snapshot();
    v_unit := round((setting('micro_usd') #>> '{}')::numeric * s.usd_pkr);
    v_price := round(s.gold_buy_tola / 11.664, 2); v_usd_pkr := s.usd_pkr;
  end if;
  v_grams := round(v_unit / v_price, 6);
  if spent_today(p_customer) + v_unit * p_units > setting_int('daily_limit_pkr') then perform fail('DAILY_LIMIT'); end if;
  insert into micro_orders (ref, customer_id, units, usd_pkr, unit_pkr, total_pkr, price_gram, idempotency_key)
    values (micro_ref('PGBX-MO'), p_customer, p_units, v_usd_pkr, v_unit, v_unit * p_units, v_price, p_key) returning * into o;
  for i in 1..p_units loop
    insert into micro_txns (ref, side, customer_id, order_id, amount_pkr, grams, price_gram, usd, status)
      values (micro_ref('PGBX-M'), 'buy', p_customer, o.id, v_unit, v_grams, v_price, (setting('micro_usd') #>> '{}')::numeric, 'pending_payment');
  end loop;
  if r.id is not null then perform confirmation_used(r.id, o.ref); end if;
  perform audit('customer:' || p_customer, 'micro.ordered', 'micro', o.ref, jsonb_build_object('units', p_units, 'total', o.total_pkr, 'usd_pkr', v_usd_pkr, 'confirmation', r.id));
  return o;
end $$;

-- $1 gold sales at the confirmed price per gram, for exactly the grams confirmed
drop function fn_micro_sell(uuid, numeric, text, text);
create function fn_micro_sell(p_customer uuid, p_grams numeric, p_iban text, p_key text, p_confirmation uuid default null) returns micro_txns language plpgsql as $$
declare t micro_txns; s rate_snapshots; v_price numeric; v_grams numeric := round(p_grams, 6); v_amount bigint; v_have numeric; v_all boolean; r rate_confirmations;
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
  if rate_chat_on() or p_confirmation is not null then
    r := take_confirmation(p_customer, p_confirmation, 'sell_micro');
    if (r.details ->> 'grams')::numeric <> v_grams then perform fail('RATE_MISMATCH'); end if;
    v_price := (r.prices ->> 'price_gram')::numeric;
  else
    s := gold_snapshot();
    v_price := round(s.gold_sell_tola / 11.664, 2);
  end if;
  v_amount := floor(v_grams * v_price);
  if v_amount < 1 then
    if not v_all then perform fail('BAD_GRAMS'); end if;
    v_amount := 1;                                                 -- dust: PGBX pays at least Rs 1 so the balance can be emptied
  end if;
  insert into micro_txns (ref, side, customer_id, amount_pkr, grams, price_gram, status, payout_to, idempotency_key)
    values (micro_ref('PGBX-MS'), 'sell', p_customer, v_amount, v_grams, v_price, 'pending_payout', p_iban, p_key) returning * into t;
  perform allocate_to_lots('sell', t.id, v_grams);
  if r.id is not null then perform confirmation_used(r.id, t.ref); end if;
  perform audit('customer:' || p_customer, 'micro.sold', 'micro', t.ref, jsonb_build_object('grams', v_grams, 'amount', v_amount, 'confirmation', r.id));
  perform notify_customer(p_customer, 'purchase', 'Gold sold',
    to_char(v_grams, 'FM990.0000') || ' g for ' || rs(v_amount) || ' · ' || t.ref || '. PGBX will pay it to your bank account ending ' || right(p_iban, 4) || '.', jsonb_build_object('name', 'micro'), false);
  return t;
end $$;

-- Gift orders at the confirmed charges, for exactly the piece confirmed
drop function fn_place_gift_once(text, uuid, text, text, text, text, text, text, text, text, text, text, date);
drop function fn_place_gift(uuid, text, text, text, text, text, text, text, text, text, text, date);
create function fn_place_gift(p_customer uuid, p_item text, p_shape text, p_design text, p_engraving text, p_message text, p_packaging text,
  p_name text, p_phone text, p_city text, p_address text, p_deliver_by date, p_confirmation uuid default null) returns gift_orders language plpgsql as $$
declare q jsonb; v gift_orders; r rate_confirmations;
begin
  perform require_active_customer(p_customer, true);                     -- buying metal: identity verified
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));
  if rate_chat_on() or p_confirmation is not null then
    r := take_confirmation(p_customer, p_confirmation, 'gift');
    if r.details ->> 'item' <> p_item or r.details ->> 'shape' <> p_shape or r.details ->> 'design' <> p_design or r.details ->> 'packaging' <> p_packaging
       or coalesce(r.details ->> 'engraving', '') <> coalesce(p_engraving, '') then perform fail('RATE_MISMATCH'); end if;
    q := r.prices || jsonb_build_object('total_pkr', r.total_pkr, 'snapshot', (select max(id) from rate_snapshots));
  else
    q := fn_gift_quote(p_item, p_shape, p_design, p_engraving, p_packaging);
  end if;
  if not (setting('gift_cities') ? p_city) then perform fail('CITY_NOT_SERVED'); end if;
  if length(coalesce(p_name, '')) < 3 or length(coalesce(p_address, '')) < 10 or length(coalesce(p_phone, '')) < 10 then perform fail('BAD_RECIPIENT'); end if;
  if p_deliver_by < pk_today() + setting_int('gift_lead_days')::int or p_deliver_by > pk_today() + 60 then perform fail('BAD_DATE'); end if;
  if spent_today(p_customer) + (q ->> 'total_pkr')::bigint > setting_int('daily_limit_pkr') then perform fail('DAILY_LIMIT'); end if;
  insert into gift_orders (ref, customer_id, item_id, shape, design, engraving, message, packaging, recipient_name, recipient_phone, recipient_city,
    recipient_address, deliver_by, metal_pkr, making_pkr, packaging_pkr, delivery_pkr, total_pkr, rate_snapshot)
  values ('PGBX-G-' || to_char(now() at time zone 'Asia/Karachi', 'YYMMDD') || '-' || lpad(nextval('service_seq')::text, 5, '0'), p_customer, p_item, p_shape, p_design,
    nullif(p_engraving, ''), nullif(p_message, ''), p_packaging, p_name, p_phone, p_city, p_address, p_deliver_by,
    (q ->> 'metal_pkr')::bigint, (q ->> 'making_pkr')::bigint, (q ->> 'packaging_pkr')::bigint, (q ->> 'delivery_pkr')::bigint, (q ->> 'total_pkr')::bigint, (q ->> 'snapshot')::bigint)
  returning * into v;
  if r.id is not null then perform confirmation_used(r.id, v.ref); end if;
  perform audit('customer:' || p_customer, 'gift.created', 'gift', v.id::text, jsonb_build_object('item', p_item, 'total', v.total_pkr, 'confirmation', r.id));
  return v;
end $$;
create function fn_place_gift_once(p_key text, p_customer uuid, p_item text, p_shape text, p_design text, p_engraving text, p_message text, p_packaging text,
  p_name text, p_phone text, p_city text, p_address text, p_deliver_by date, p_confirmation uuid default null) returns gift_orders language plpgsql as $$
declare v gift_orders;
begin
  select * into v from gift_orders where customer_id = p_customer and idempotency_key = p_key;
  if found then return v; end if;
  begin
    v := fn_place_gift(p_customer, p_item, p_shape, p_design, p_engraving, p_message, p_packaging, p_name, p_phone, p_city, p_address, p_deliver_by, p_confirmation);
    update gift_orders set idempotency_key = p_key where id = v.id returning * into v;
  exception when unique_violation then
    select * into v from gift_orders where customer_id = p_customer and idempotency_key = p_key;
    if not found then raise; end if;
  end;
  return v;
end $$;

-- ---------- selling bars back ----------
create table bar_sales (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  customer_id uuid not null references customers(id),
  confirmation_id uuid not null references rate_confirmations(id),
  lines jsonb not null,                                        -- [{product_id, units, unit_price_pkr}]
  total_pkr bigint not null check (total_pkr > 0),
  payout_to text not null,
  status text not null default 'pending_payout' check (status in ('pending_payout', 'paid_out')),
  payout_ref text,
  paid_out_at timestamptz,
  paid_out_by text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (customer_id, idempotency_key)
);
create index on bar_sales (status) where status = 'pending_payout';
create unique index bar_sales_payout_ref on bar_sales (payout_ref) where payout_ref is not null;
-- A sale's lines and amount never change; only its payout is recorded
create function chat_append_only_sale() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'APPEND_ONLY: bar sales cannot be deleted'; end if;
  if (to_jsonb(new) - array['status', 'payout_ref', 'paid_out_at', 'paid_out_by']) <> (to_jsonb(old) - array['status', 'payout_ref', 'paid_out_at', 'paid_out_by']) then
    raise exception 'APPEND_ONLY: a bar sale cannot be changed';
  end if;
  return new;
end $$;
create trigger bar_sales_append_only before update or delete on bar_sales for each row execute function chat_append_only_sale();

-- Bars leave the wallet when the sale is agreed; PGBX then owes the confirmed amount to the customer's bank account
create function fn_sell_bars(p_customer uuid, p_confirmation uuid, p_iban text, p_key text) returns bar_sales language plpgsql as $$
declare b bar_sales; r rate_confirmations; l jsonb; v_lines jsonb := '[]'; v_ref text;
begin
  if coalesce(p_key, '') = '' then perform fail('BAD_KEY'); end if;
  perform require_active_customer(p_customer, true);
  perform pg_advisory_xact_lock(hashtext('buy:' || p_customer));
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
create function fn_bar_sale_payout(p_staff uuid, p_id uuid, p_ref text) returns bar_sales language plpgsql as $$
declare b bar_sales; v_ref text := btrim(coalesce(p_ref, ''));
begin
  if length(v_ref) < 4 then perform fail('BAD_REF'); end if;
  select * into b from bar_sales where id = p_id for update;
  if not found then perform fail('NOT_FOUND'); end if;
  if b.status <> 'pending_payout' then perform fail('ALREADY_PAID'); end if;
  update bar_sales set status = 'paid_out', payout_ref = v_ref, paid_out_at = now(), paid_out_by = 'staff:' || p_staff where id = p_id returning * into b;
  perform notify_customer(b.customer_id, 'purchase', 'Payment sent', rs(b.total_pkr) || ' for ' || b.ref || ' was sent to your bank account ending ' || right(b.payout_to, 4) || '. Reference ' || v_ref || '.',
    jsonb_build_object('name', 'wallet'), true);
  perform audit('staff:' || p_staff, 'bars.paid_out', 'bar_sale', b.ref, jsonb_build_object('ref', v_ref, 'amount', b.total_pkr));
  return b;
end $$;

-- ---------- closing accounts, purging, reconciliation ----------
-- A bar sale payment still on its way blocks closing; open chats close with the account.
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
  select (select count(*) from micro_txns where customer_id = p_customer and status = 'pending_payout')
       + (select count(*) from bar_sales where customer_id = p_customer and status = 'pending_payout') into v_payouts;
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
  update rate_confirmations r set status = 'withdrawn' from rate_chats ch where ch.id = r.chat_id and ch.customer_id = p_customer and r.status = 'valid';
  update rate_chats set status = 'closed', closed_at = now(), closed_by = 'system' where customer_id = p_customer and status <> 'closed';
  perform audit('customer:' || p_customer, 'account.closed', 'customer', p_customer::text, '{}');
  return jsonb_build_object('closed', true, 'blockers', '[]'::jsonb);
end $$;

-- Purge also removes chat text, attachments and bank accounts of bar sales for purged customers
alter function fn_purge_closed() rename to fn_purge_closed_base;
create function fn_purge_closed() returns int language plpgsql as $$
declare n int;
begin
  n := fn_purge_closed_base();
  update chat_messages m set body = '[removed]' from rate_chats c, customers u
    where c.id = m.chat_id and u.id = c.customer_id and u.purged_at is not null and m.body <> '[removed]' and m.sender <> 'system';
  update chat_attachments a set data = null, name = '[removed]' from rate_chats c, customers u
    where c.id = a.chat_id and u.id = c.customer_id and u.purged_at is not null and a.data is not null;
  return n;
end $$;

-- Reconciliation adds bar sales owed to customers
alter function fn_reconcile(date) rename to fn_reconcile_base;
create function fn_reconcile(p_day date) returns jsonb language plpgsql stable as $$
begin
  return fn_reconcile_base(p_day) || jsonb_build_object('bar_sales', jsonb_build_object(
    'pending', (select count(*) from bar_sales where status = 'pending_payout'),
    'pending_pkr', (select coalesce(sum(total_pkr), 0) from bar_sales where status = 'pending_payout'),
    'bought_back_pkr', (select coalesce(sum(total_pkr), 0) from bar_sales where created_at >= pk_day_start(p_day) and created_at < pk_day_start(p_day + 1))));
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
alter table rate_chats enable row level security;
alter table chat_messages enable row level security;
alter table chat_attachments enable row level security;
alter table rate_confirmations enable row level security;
alter table bar_sales enable row level security;
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
