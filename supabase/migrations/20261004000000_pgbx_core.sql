-- =====================================================================
-- PGBX core schema
-- Portable PostgreSQL 15+ (runs on Supabase, plain Postgres and PGlite).
-- Money is whole PKR (bigint). Metal is whole units of a product.
-- Every movement of money or metal happens inside one of the fn_* functions
-- below, in a single transaction, and is written to audit_log.
-- The ledger is append-only: the database refuses updates and deletes.
-- Row level security is enabled on every table with no policies, so the
-- public Supabase keys can read nothing; only the API (service role /
-- direct connection) talks to the database.
-- Requirement IDs refer to the PGBX SRS.
-- =====================================================================

-- ---------- configuration ----------
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
-- Sample values until PGBX decides (FR-M2). null = not decided yet.
insert into settings (key, value) values
  ('max_units_per_order', '10'),
  ('daily_limit_pkr', '1500000'),
  ('price_lock_seconds', '60'),
  ('rate_stale_seconds', '30'),
  ('redemption_valid_hours', '24'),
  ('order_payment_minutes', '30'),
  ('session_days', '30'),
  ('spread', '{"gold": 0.012, "silver": 0.025}'),
  ('retention_days', 'null'),
  ('redemption_fee_pkr', 'null'),
  ('min_purchase_pkr', 'null');

create table products (
  id text primary key,
  metal text not null check (metal in ('gold', 'silver')),
  label text not null,
  grams numeric(12, 4) not null check (grams > 0),
  premium_pkr bigint not null check (premium_pkr >= 0),
  active boolean not null default true,
  sort int not null default 0
);
insert into products (id, metal, label, grams, premium_pkr, sort) values
  ('g-10mg', 'gold', '10 mg', 0.01, 120, 1), ('g-20mg', 'gold', '20 mg', 0.02, 160, 2), ('g-50mg', 'gold', '50 mg', 0.05, 250, 3),
  ('g-100mg', 'gold', '100 mg', 0.1, 350, 4), ('g-500mg', 'gold', '500 mg', 0.5, 800, 5), ('g-1g', 'gold', '1 gram', 1, 1200, 6),
  ('g-5g', 'gold', '5 gram', 5, 3500, 7), ('s-1t', 'silver', '1 tola', 11.664, 350, 8), ('s-3t', 'silver', '3 tola', 34.992, 800, 9),
  ('s-5t', 'silver', '5 tola', 58.32, 1200, 10), ('s-10t', 'silver', '10 tola', 116.64, 2000, 11);

-- ---------- people ----------
create table customers (
  id uuid primary key default gen_random_uuid(),
  phone text unique check (phone ~ '^3[0-9]{9}$'),          -- null once the account is closed
  closed_phone text,                                         -- kept until purge for records
  name text, cnic text, dob date, email text, address text,
  kyc_status text not null default 'none' check (kyc_status in ('none', 'pending', 'verified', 'failed', 'review', 'reverify')),
  kyc_at timestamptz,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  purge_after timestamptz,
  purged_at timestamptz
);

create table sessions (
  token_hash text primary key,                               -- sha-256 of the bearer token; the token itself is never stored
  customer_id uuid not null references customers(id),
  device text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_customer on sessions (customer_id);

create table dealers (
  id text primary key,
  name text not null,
  area text not null,
  address text,
  phone text,
  lat numeric(9, 6),
  lng numeric(9, 6),
  hours text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table staff (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  role text not null check (role in ('admin', 'ops', 'dealer')),
  dealer_id text references dealers(id),
  password_hash text not null,                               -- scrypt, set by the API
  totp_secret text not null,                                 -- second factor (RFC 6238)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (role <> 'dealer' or dealer_id is not null)
);

create table staff_sessions (
  token_hash text primary key,
  staff_id uuid not null references staff(id),
  mfa_passed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table kyc_checks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  provider text not null,
  provider_ref text,
  status text not null default 'started' check (status in ('started', 'submitted', 'passed', 'failed', 'review')),
  reason text,
  data jsonb not null default '{}',                          -- provider result summary; no images
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);

-- ---------- prices ----------
create table rate_snapshots (
  id bigint generated always as identity primary key,
  gold_buy_tola bigint not null check (gold_buy_tola > 0),
  gold_sell_tola bigint not null check (gold_sell_tola > 0),
  silver_buy_tola bigint not null check (silver_buy_tola > 0),
  silver_sell_tola bigint not null check (silver_sell_tola > 0),
  source text not null,
  fetched_at timestamptz not null default now()
);

create table price_locks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  snapshot_id bigint not null references rate_snapshots(id),
  prices jsonb not null,                                     -- { product_id: unit price PKR }
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ---------- orders and payments ----------
create sequence receipt_seq;
create table orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  idempotency_key text not null,
  lock_id uuid not null references price_locks(id),
  method text not null check (method in ('bank', 'card', 'mwallet')),
  total_pkr bigint not null check (total_pkr > 0),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'credited', 'flagged', 'failed', 'refunded', 'expired')),
  receipt_no text not null unique,
  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  credited_at timestamptz,
  resolved_at timestamptz,
  resolved_by text,
  unique (customer_id, idempotency_key)                      -- the same request can never create two orders (Rule 2)
);
create index orders_customer on orders (customer_id, created_at desc);
create index orders_status on orders (status);

create table order_lines (
  order_id uuid not null references orders(id),
  product_id text not null references products(id),
  units int not null check (units between 1 and 1000),
  unit_price_pkr bigint not null check (unit_price_pkr > 0),
  primary key (order_id, product_id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  provider text not null,
  provider_ref text not null,
  amount_pkr bigint not null,
  status text not null check (status in ('initiated', 'succeeded', 'failed', 'refunded')),
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_ref)                            -- a provider event is processed once
);

-- ---------- the ledger (FR-W3) ----------
create table ledger (
  id bigint generated always as identity primary key,
  customer_id uuid not null references customers(id),
  product_id text not null references products(id),
  delta int not null check (delta <> 0),
  reason text not null check (reason in ('purchase', 'redemption', 'adjustment')),
  ref text not null,
  unit_price_pkr bigint,
  created_at timestamptz not null default now(),
  created_by text not null
);
create index ledger_customer on ledger (customer_id, created_at);

create function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'LEDGER_APPEND_ONLY: ledger entries cannot be changed or removed; add a correcting entry instead';
end $$;
create trigger ledger_no_update before update or delete on ledger for each row execute function ledger_append_only();
create trigger ledger_no_truncate before truncate on ledger for each statement execute function ledger_append_only();

-- ---------- dealers, stock and redemption ----------
create table dealer_stock (
  dealer_id text not null references dealers(id),
  product_id text not null references products(id),
  units int not null default 0 check (units >= 0),
  updated_at timestamptz not null default now(),
  primary key (dealer_id, product_id)
);

create table redemptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  product_id text not null references products(id),
  units int not null check (units > 0),
  dealer_id text not null references dealers(id),
  code text not null check (code ~ '^[0-9]{6}$'),
  status text not null default 'requested' check (status in ('requested', 'ready', 'completed', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  serials text[],
  cnic_checked boolean,
  handled_by uuid references staff(id)
);
-- An active code is unique, so a dealer lookup can never match two reservations (FR-D4)
create unique index redemptions_active_code on redemptions (code) where status in ('requested', 'ready');
create index redemptions_customer on redemptions (customer_id, created_at desc);
create index redemptions_dealer on redemptions (dealer_id, status);

-- ---------- custody check ----------
create table vault_counts (
  id bigint generated always as identity primary key,
  product_id text not null references products(id),
  units int not null check (units >= 0),
  counted_at timestamptz not null default now(),
  counted_by text not null,
  note text
);

-- ---------- notifications and alerts ----------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  kind text not null check (kind in ('purchase', 'redemption', 'security', 'account', 'alert')),
  title text not null,
  body text not null,
  link jsonb,
  push boolean not null default true,                       -- false for actions the customer just took
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz
);
create index notifications_customer on notifications (customer_id, created_at desc);

create table push_tokens (
  token text primary key,
  customer_id uuid not null references customers(id),
  platform text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table price_alerts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  metal text not null check (metal in ('gold', 'silver')),
  dir text not null check (dir in ('above', 'below')),
  target_pkr bigint not null check (target_pkr > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  fired_at timestamptz
);

-- ---------- abuse limits and audit ----------
create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,                                       -- 'customer:<id>', 'staff:<id>', 'system', 'provider:<name>'
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}'
);
create index audit_entity on audit_log (entity, entity_id);
create function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'AUDIT_APPEND_ONLY: the audit log cannot be changed';
end $$;
create trigger audit_no_update before update or delete on audit_log for each row execute function audit_append_only();

-- ---------- derived views ----------
create view v_holdings as
  select customer_id, product_id, sum(delta)::int as units from ledger group by customer_id, product_id having sum(delta) <> 0;

create view v_reserved as
  select customer_id, product_id, dealer_id, sum(units)::int as units from redemptions
  where status in ('requested', 'ready') and expires_at > now() group by customer_id, product_id, dealer_id;

-- =====================================================================
-- Helpers
-- =====================================================================
create function setting(p_key text) returns jsonb language sql stable as $$
  select value from settings where key = p_key
$$;
create function setting_int(p_key text) returns bigint language sql stable as $$
  select (value #>> '{}')::bigint from settings where key = p_key
$$;

create function audit(p_actor text, p_action text, p_entity text, p_id text, p_data jsonb default '{}') returns void language sql as $$
  insert into audit_log (actor, action, entity, entity_id, data) values (p_actor, p_action, p_entity, p_id, coalesce(p_data, '{}'))
$$;

-- Errors use a stable CODE as the message so the API can turn them into plain language.
create function fail(p_code text) returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end $$;

create function notify_customer(p_customer uuid, p_kind text, p_title text, p_body text, p_link jsonb, p_push boolean default true)
returns void language sql as $$
  insert into notifications (customer_id, kind, title, body, link, push) values (p_customer, p_kind, p_title, p_body, p_link, p_push)
$$;

create function holdings_of(p_customer uuid, p_product text) returns int language sql stable as $$
  select coalesce(sum(delta), 0)::int from ledger where customer_id = p_customer and product_id = p_product
$$;

create function reserved_of(p_customer uuid, p_product text) returns int language sql stable as $$
  select coalesce(sum(units), 0)::int from redemptions
  where customer_id = p_customer and product_id = p_product and status in ('requested', 'ready') and expires_at > now()
$$;

create function require_active_customer(p_customer uuid, p_need_kyc boolean) returns customers language plpgsql as $$
declare c customers;
begin
  select * into c from customers where id = p_customer;
  if not found or c.status <> 'active' then perform fail('ACCOUNT_INACTIVE'); end if;
  if p_need_kyc and c.kyc_status <> 'verified' then perform fail('KYC_REQUIRED'); end if;
  return c;
end $$;

-- =====================================================================
-- Prices (Rule 1, FR-R3, FR-B2)
-- =====================================================================
create function fn_record_rates(p_gold_buy bigint, p_gold_sell bigint, p_silver_buy bigint, p_silver_sell bigint, p_source text)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into rate_snapshots (gold_buy_tola, gold_sell_tola, silver_buy_tola, silver_sell_tola, source)
  values (p_gold_buy, p_gold_sell, p_silver_buy, p_silver_sell, p_source) returning id into v_id;
  perform fn_fire_alerts(v_id);
  return v_id;
end $$;

-- Unit price = metal value at today's buy rate + product premium, rounded to whole rupees.
create function product_price(p_product products, p_snap rate_snapshots) returns bigint language sql immutable as $$
  select round((case when p_product.metal = 'gold' then p_snap.gold_buy_tola else p_snap.silver_buy_tola end) / 11.664 * p_product.grams
               + p_product.premium_pkr)::bigint
$$;

create function fn_create_lock(p_customer uuid, p_products text[]) returns price_locks language plpgsql as $$
declare
  v_snap rate_snapshots; v_prices jsonb := '{}'; p products; v_lock price_locks;
begin
  perform require_active_customer(p_customer, false);
  select * into v_snap from rate_snapshots order by id desc limit 1;
  if not found or v_snap.fetched_at < now() - make_interval(secs => setting_int('rate_stale_seconds')) then perform fail('RATES_STALE'); end if;
  if coalesce(array_length(p_products, 1), 0) = 0 then perform fail('NO_PRODUCTS'); end if;
  for p in select * from products where id = any (p_products) and active loop
    v_prices := v_prices || jsonb_build_object(p.id, product_price(p, v_snap));
  end loop;
  if (select count(*) from jsonb_object_keys(v_prices)) <> (select count(distinct x) from unnest(p_products) x) then perform fail('UNKNOWN_PRODUCT'); end if;
  insert into price_locks (customer_id, snapshot_id, prices, expires_at)
  values (p_customer, v_snap.id, v_prices, now() + make_interval(secs => setting_int('price_lock_seconds')))
  returning * into v_lock;
  return v_lock;
end $$;

-- =====================================================================
-- Orders (FR-B1–B8)
-- p_lines: [{"product_id": "g-1g", "units": 2}, ...]
-- =====================================================================
create function fn_place_order(p_customer uuid, p_lock uuid, p_lines jsonb, p_method text, p_key text) returns orders language plpgsql as $$
declare
  v_order orders; v_lock price_locks; v_total bigint := 0; v_units int := 0; v_spent bigint; l jsonb; v_price bigint;
begin
  select * into v_order from orders where customer_id = p_customer and idempotency_key = p_key;
  if found then return v_order; end if;                                  -- repeat of the same request (Rule 2)
  perform require_active_customer(p_customer, true);
  select * into v_lock from price_locks where id = p_lock and customer_id = p_customer;
  if not found then perform fail('LOCK_NOT_FOUND'); end if;
  if v_lock.expires_at < now() then perform fail('LOCK_EXPIRED'); end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then perform fail('NO_PRODUCTS'); end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_price := (v_lock.prices ->> (l ->> 'product_id'))::bigint;
    if v_price is null then perform fail('PRODUCT_NOT_LOCKED'); end if;
    if (l ->> 'units')::int < 1 then perform fail('BAD_UNITS'); end if;
    v_units := v_units + (l ->> 'units')::int;
    v_total := v_total + v_price * (l ->> 'units')::int;
  end loop;
  if v_units > setting_int('max_units_per_order') then perform fail('ORDER_LIMIT'); end if;
  if setting_int('min_purchase_pkr') is not null and v_total < setting_int('min_purchase_pkr') then perform fail('MIN_PURCHASE'); end if;
  select coalesce(sum(total_pkr), 0) into v_spent from orders
  where customer_id = p_customer and status in ('pending_payment', 'credited', 'flagged') and created_at >= date_trunc('day', now());
  if v_spent + v_total > setting_int('daily_limit_pkr') then perform fail('DAILY_LIMIT'); end if;
  insert into orders (customer_id, idempotency_key, lock_id, method, total_pkr, receipt_no)
  values (p_customer, p_key, p_lock, p_method, v_total, 'PGBX-R-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('receipt_seq')::text, 6, '0'))
  returning * into v_order;
  insert into order_lines (order_id, product_id, units, unit_price_pkr)
  select v_order.id, x ->> 'product_id', (x ->> 'units')::int, (v_lock.prices ->> (x ->> 'product_id'))::bigint
  from jsonb_array_elements(p_lines) x;
  perform audit('customer:' || p_customer, 'order.placed', 'order', v_order.id::text, jsonb_build_object('total', v_total, 'lines', p_lines));
  return v_order;
end $$;

-- Credit the wallet for a paid order. Separate so operations can retry it.
create function credit_order(p_order orders, p_actor text) returns void language plpgsql as $$
begin
  insert into ledger (customer_id, product_id, delta, reason, ref, unit_price_pkr, created_by)
  select p_order.customer_id, product_id, units, 'purchase', p_order.receipt_no, unit_price_pkr, p_actor from order_lines where order_id = p_order.id;
  update orders set status = 'credited', credited_at = now() where id = p_order.id;
end $$;

-- Called from the payment provider's verified webhook (FR-B4). Safe to call more than once for the same event.
create function fn_payment_succeeded(p_provider text, p_ref text, p_order uuid, p_amount bigint, p_data jsonb default '{}')
returns orders language plpgsql as $$
declare v_order orders; v_new boolean;
begin
  select * into v_order from orders where id = p_order for update;
  if not found then perform fail('ORDER_NOT_FOUND'); end if;
  insert into payments (order_id, provider, provider_ref, amount_pkr, status, data)
  values (p_order, p_provider, p_ref, p_amount, 'succeeded', coalesce(p_data, '{}'))
  on conflict (provider, provider_ref) do nothing;
  get diagnostics v_new = row_count;
  if not v_new or v_order.status <> 'pending_payment' then
    if v_new and v_order.status in ('expired', 'failed') then   -- money arrived after the order lapsed: hold for operations
      update orders set status = 'flagged', paid_at = now(), note = 'Paid after the order lapsed; refund or credit' where id = p_order returning * into v_order;
      perform audit('provider:' || p_provider, 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'late_payment'));
    end if;
    return v_order;
  end if;
  update orders set paid_at = now() where id = p_order;
  if p_amount <> v_order.total_pkr then
    update orders set status = 'flagged', note = 'Amount paid differs from the order total' where id = p_order returning * into v_order;
    perform audit('provider:' || p_provider, 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'amount_mismatch', 'paid', p_amount));
    perform notify_customer(v_order.customer_id, 'purchase', 'Payment received, order being completed',
      v_order.receipt_no || '. PGBX operations is completing your order.', jsonb_build_object('name', 'receipt', 'oid', v_order.id), false);
    return v_order;
  end if;
  begin
    perform credit_order(v_order, 'provider:' || p_provider);
  exception when others then                                        -- FR-B5: never leave money and metal unmatched
    update orders set status = 'flagged', note = 'Crediting failed: ' || sqlerrm where id = p_order;
    perform audit('system', 'order.flagged', 'order', p_order::text, jsonb_build_object('reason', 'credit_failed', 'error', sqlerrm));
    select * into v_order from orders where id = p_order;
    return v_order;
  end;
  select * into v_order from orders where id = p_order;
  perform audit('provider:' || p_provider, 'order.credited', 'order', p_order::text, jsonb_build_object('payment', p_ref));
  perform notify_customer(v_order.customer_id, 'purchase', 'Purchase confirmed', v_order.receipt_no || ' · Rs ' || v_order.total_pkr,
    jsonb_build_object('name', 'receipt', 'oid', v_order.id), false);
  return v_order;
end $$;

create function fn_payment_failed(p_provider text, p_ref text, p_order uuid, p_data jsonb default '{}') returns orders language plpgsql as $$
declare v_order orders;
begin
  insert into payments (order_id, provider, provider_ref, amount_pkr, status, data)
  select id, p_provider, p_ref, total_pkr, 'failed', coalesce(p_data, '{}') from orders where id = p_order
  on conflict (provider, provider_ref) do nothing;
  update orders set status = 'failed' where id = p_order and status = 'pending_payment' returning * into v_order;
  if v_order.id is null then select * into v_order from orders where id = p_order; end if;
  perform audit('provider:' || p_provider, 'payment.failed', 'order', p_order::text, '{}');
  return v_order;
end $$;

-- Operations resolves a flagged order: credit the metal, or record the refund (FR-B5, FR-M).
create function fn_resolve_order(p_staff uuid, p_order uuid, p_action text, p_note text) returns orders language plpgsql as $$
declare v_order orders;
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
    perform notify_customer(v_order.customer_id, 'purchase', 'Order refunded', v_order.receipt_no || ' was refunded to your payment method.',
      jsonb_build_object('name', 'receipt', 'oid', v_order.id), true);
  else
    perform fail('BAD_ACTION');
  end if;
  update orders set resolved_at = now(), resolved_by = 'staff:' || p_staff, note = coalesce(p_note, note) where id = p_order returning * into v_order;
  perform audit('staff:' || p_staff, 'order.resolved', 'order', p_order::text, jsonb_build_object('action', p_action, 'note', p_note));
  return v_order;
end $$;

create function fn_expire_orders() returns int language plpgsql as $$
declare n int;
begin
  update orders set status = 'expired'
  where status = 'pending_payment' and created_at < now() - make_interval(mins => setting_int('order_payment_minutes')::int);
  get diagnostics n = row_count;
  if n > 0 then perform audit('system', 'orders.expired', 'order', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;

-- =====================================================================
-- Redemption at a dealer (FR-D1–D9, FR-DL2–DL4)
-- The 6-digit code is generated by the API with a cryptographic RNG.
-- =====================================================================
create function fn_reserve(p_customer uuid, p_product text, p_units int, p_dealer text, p_code text) returns redemptions language plpgsql as $$
declare v_r redemptions; v_stock int; v_held int; v_dealer dealers;
begin
  perform require_active_customer(p_customer, true);
  if p_units < 1 then perform fail('BAD_UNITS'); end if;
  perform pg_advisory_xact_lock(hashtext('redeem:' || p_customer));      -- one reservation decision at a time per customer
  v_held := holdings_of(p_customer, p_product) - reserved_of(p_customer, p_product);
  if v_held < p_units then perform fail('INSUFFICIENT_HOLDINGS'); end if;
  select * into v_dealer from dealers where id = p_dealer and active;
  if not found then perform fail('DEALER_UNAVAILABLE'); end if;
  select coalesce(s.units, 0) - coalesce((select sum(units) from redemptions r where r.dealer_id = p_dealer and r.product_id = p_product
      and r.status in ('requested', 'ready') and r.expires_at > now()), 0)
    into v_stock from dealer_stock s where s.dealer_id = p_dealer and s.product_id = p_product;
  if coalesce(v_stock, 0) < p_units then perform fail('OUT_OF_STOCK'); end if;
  insert into redemptions (customer_id, product_id, units, dealer_id, code, expires_at)
  values (p_customer, p_product, p_units, p_dealer, p_code, now() + make_interval(hours => setting_int('redemption_valid_hours')::int))
  returning * into v_r;
  perform audit('customer:' || p_customer, 'redemption.reserved', 'redemption', v_r.id::text,
    jsonb_build_object('product', p_product, 'units', p_units, 'dealer', p_dealer));
  perform notify_customer(p_customer, 'redemption', 'Reserved for collection',
    p_units || ' × ' || p_product || ' at ' || v_dealer.name || '. Code ' || p_code || ', valid for ' || setting_int('redemption_valid_hours') || ' hours.',
    jsonb_build_object('name', 'code', 'rid', v_r.id), false);
  return v_r;
end $$;

create function fn_cancel_redemption(p_customer uuid, p_id uuid) returns redemptions language plpgsql as $$
declare v_r redemptions;
begin
  update redemptions set status = 'cancelled', cancelled_at = now()
  where id = p_id and customer_id = p_customer and status in ('requested', 'ready') returning * into v_r;
  if v_r.id is null then perform fail('REDEMPTION_NOT_ACTIVE'); end if;
  perform audit('customer:' || p_customer, 'redemption.cancelled', 'redemption', p_id::text, '{}');
  return v_r;
end $$;

-- Dealer looks up a code: only their own dealer's active reservations; the CNIC is shown masked for comparison with the card.
create function fn_dealer_lookup(p_staff uuid, p_code text) returns jsonb language plpgsql as $$
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
  perform audit('staff:' || p_staff, 'redemption.lookup', 'redemption', v_r.id::text, '{}');
  return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'product_id', v_r.product_id, 'units', v_r.units, 'expires_at', v_r.expires_at,
    'customer_name', v_c.name, 'cnic_masked', left(v_c.cnic, 5) || '-•••••••-' || right(v_c.cnic, 1));
end $$;

create function dealer_owned(p_staff uuid, p_id uuid) returns redemptions language plpgsql as $$
declare v_s staff; v_r redemptions;
begin
  select * into v_s from staff where id = p_staff and active and role = 'dealer';
  if not found then perform fail('NOT_A_DEALER'); end if;
  select * into v_r from redemptions where id = p_id for update;
  if not found or v_r.dealer_id <> v_s.dealer_id then perform fail('CODE_NOT_FOUND'); end if;
  return v_r;
end $$;

create function fn_dealer_ready(p_staff uuid, p_id uuid) returns redemptions language plpgsql as $$
declare v_r redemptions; v_d dealers;
begin
  v_r := dealer_owned(p_staff, p_id);
  if v_r.status <> 'requested' then perform fail('REDEMPTION_NOT_REQUESTED'); end if;
  if v_r.expires_at < now() then perform fail('CODE_EXPIRED'); end if;
  update redemptions set status = 'ready', ready_at = now() where id = p_id returning * into v_r;
  select * into v_d from dealers where id = v_r.dealer_id;
  perform audit('staff:' || p_staff, 'redemption.ready', 'redemption', p_id::text, '{}');
  perform notify_customer(v_r.customer_id, 'redemption', 'Ready for collection', v_r.product_id || ' is ready at ' || v_d.name || '. Bring your CNIC.',
    jsonb_build_object('name', 'code', 'rid', v_r.id), true);
  return v_r;
end $$;

-- Hand over: the dealer confirms the CNIC matched and records the serial number of every bar handed over.
create function fn_dealer_handover(p_staff uuid, p_id uuid, p_serials text[], p_cnic_checked boolean) returns redemptions language plpgsql as $$
declare v_r redemptions; v_left int; v_d dealers;
begin
  v_r := dealer_owned(p_staff, p_id);
  if v_r.status <> 'ready' then perform fail('REDEMPTION_NOT_READY'); end if;
  if v_r.expires_at < now() then perform fail('CODE_EXPIRED'); end if;
  if not coalesce(p_cnic_checked, false) then perform fail('CNIC_NOT_CHECKED'); end if;
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
    v_r.units || ' × ' || v_r.product_id || ' collected at ' || v_d.name || '. Serial ' || array_to_string(p_serials, ', ') || '.',
    jsonb_build_object('name', 'code', 'rid', v_r.id), true);
  return v_r;
end $$;

create function fn_expire_redemptions() returns int language plpgsql as $$
declare n int;
begin
  update redemptions set status = 'expired' where status in ('requested', 'ready') and expires_at < now();
  get diagnostics n = row_count;
  if n > 0 then perform audit('system', 'redemptions.expired', 'redemption', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;

-- =====================================================================
-- Price alerts (FR-R6)
-- =====================================================================
create function fn_fire_alerts(p_snapshot bigint) returns int language plpgsql as $$
declare s rate_snapshots; a price_alerts; n int := 0; v_price bigint;
begin
  select * into s from rate_snapshots where id = p_snapshot;
  for a in select * from price_alerts where active for update skip locked loop
    v_price := case when a.metal = 'gold' then s.gold_buy_tola else s.silver_buy_tola end;
    if (a.dir = 'above' and v_price >= a.target_pkr) or (a.dir = 'below' and v_price <= a.target_pkr) then
      update price_alerts set active = false, fired_at = now() where id = a.id;
      perform notify_customer(a.customer_id, 'alert', initcap(a.metal) || ' is ' || a.dir || ' Rs ' || a.target_pkr,
        'Buy rate is now Rs ' || v_price || ' per tola.', jsonb_build_object('name', 'history', 'metal', a.metal), true);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- =====================================================================
-- Account closure and data retention (Apple 5.1.1(v), Google account deletion)
-- =====================================================================
create function fn_close_account(p_customer uuid) returns jsonb language plpgsql as $$
declare v_blockers jsonb := '[]'; v_units int; v_active int; v_flagged int; v_days bigint;
begin
  perform require_active_customer(p_customer, false);
  select coalesce(sum(units), 0) into v_units from v_holdings where customer_id = p_customer;
  select count(*) into v_active from redemptions where customer_id = p_customer and status in ('requested', 'ready') and expires_at > now();
  select count(*) into v_flagged from orders where customer_id = p_customer and status in ('flagged', 'pending_payment');
  if v_units > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'HOLDINGS', 'units', v_units); end if;
  if v_active > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'ACTIVE_REDEMPTIONS', 'count', v_active); end if;
  if v_flagged > 0 then v_blockers := v_blockers || jsonb_build_object('code', 'OPEN_ORDERS', 'count', v_flagged); end if;
  if jsonb_array_length(v_blockers) > 0 then return jsonb_build_object('closed', false, 'blockers', v_blockers); end if;
  v_days := setting_int('retention_days');
  update customers set status = 'closed', closed_at = now(), closed_phone = phone, phone = null,
    purge_after = case when v_days is null then null else now() + make_interval(days => v_days::int) end
  where id = p_customer;
  update sessions set revoked_at = now() where customer_id = p_customer and revoked_at is null;
  delete from push_tokens where customer_id = p_customer;
  update price_alerts set active = false where customer_id = p_customer;
  perform audit('customer:' || p_customer, 'account.closed', 'customer', p_customer::text, '{}');
  return jsonb_build_object('closed', true, 'blockers', '[]'::jsonb);
end $$;

-- Remove personal data once the retention period has passed. Orders and the ledger stay, without personal details.
create function fn_purge_closed() returns int language plpgsql as $$
declare n int;
begin
  with p as (
    update customers set name = null, cnic = null, dob = null, email = null, address = null, closed_phone = null, purged_at = now()
    where status = 'closed' and purge_after is not null and purge_after < now() and purged_at is null returning id
  ), d as (delete from notifications where customer_id in (select id from p))
  select count(*) into n from p;
  if n > 0 then perform audit('system', 'customers.purged', 'customer', null, jsonb_build_object('count', n)); end if;
  return n;
end $$;

-- =====================================================================
-- Daily reconciliation (money ↔ orders ↔ metal)
-- =====================================================================
create function fn_reconcile(p_day date) returns jsonb language plpgsql stable as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'day', p_day,
    'payments_succeeded_pkr', (select coalesce(sum(amount_pkr), 0) from payments where status = 'succeeded' and created_at::date = p_day),
    'orders_credited_pkr', (select coalesce(sum(o.total_pkr), 0) from orders o where o.status = 'credited' and o.credited_at::date = p_day),
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
    'flagged_orders', (select count(*) from orders where status = 'flagged')
  ) into v;
  return v;
end $$;

-- =====================================================================
-- Abuse limits shared by every server instance
-- Returns 0 when allowed, otherwise the seconds until the window resets.
-- =====================================================================
create function fn_rate_limit(p_key text, p_window_secs int, p_max int) returns int language plpgsql as $$
declare v_start timestamptz; v_hits int;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into rate_limits (key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1 returning hits into v_hits;
  if random() < 0.01 then delete from rate_limits where window_start < now() - interval '1 day'; end if;
  if v_hits > p_max then return greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_secs) - now())))::int); end if;
  return 0;
end $$;

-- =====================================================================
-- Lock everything down: no access through the public Supabase keys.
-- =====================================================================
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
