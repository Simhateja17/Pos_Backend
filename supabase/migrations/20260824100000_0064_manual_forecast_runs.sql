-- 0064 — temporary, auditable manual forecast runs.
--
-- The browser/backend queue a tenant + store run.  The isolated ml_forecast
-- role claims and completes it through SECURITY DEFINER adapters; it does not
-- receive direct access to the application tables needed to build context.

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'forecast_run_source') then
    create type public.forecast_run_source as enum ('manual_test', 'nightly');
  end if;
  if not exists (select 1 from pg_type where typname = 'forecast_run_status') then
    create type public.forecast_run_status as enum ('queued', 'running', 'completed', 'failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'forecast_run_item_disposition') then
    create type public.forecast_run_item_disposition as enum (
      'forecast_written', 'heuristic_won', 'ineligible', 'no_supplier',
      'sufficient_stock', 'failed'
    );
  end if;
end
$$;

grant usage on type public.forecast_run_source, public.forecast_run_status,
  public.forecast_run_item_disposition to ml_forecast;

create table if not exists public.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  requested_by uuid references public.staff_members(id) on delete set null,
  source public.forecast_run_source not null default 'manual_test',
  status public.forecast_run_status not null default 'queued',
  idempotency_key text not null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  products_evaluated integer not null default 0 check (products_evaluated >= 0),
  products_eligible integer not null default 0 check (products_eligible >= 0),
  forecasts_won integer not null default 0 check (forecasts_won >= 0),
  forecasts_written integer not null default 0 check (forecasts_written >= 0),
  products_skipped integer not null default 0 check (products_skipped >= 0),
  error_code text,
  error_message text,
  worker_version text,
  model_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, store_id, idempotency_key),
  constraint forecast_runs_idempotency_key_nonempty check (length(trim(idempotency_key)) between 1 and 128),
  constraint forecast_runs_error_message_bounded check (error_message is null or length(error_message) <= 1000)
);

create table if not exists public.forecast_run_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.forecast_runs(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete cascade,
  history_days integer,
  trailing_units numeric,
  total_units numeric,
  eligible boolean not null default false,
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_lead_days integer,
  review_days integer not null default 7,
  forecast_horizon_days integer,
  rule_based jsonb not null default '{}'::jsonb,
  ml_result jsonb not null default '{}'::jsonb,
  disposition public.forecast_run_item_disposition not null,
  reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, variant_id),
  constraint forecast_run_items_tenant_run_fk
    foreign key (tenant_id, run_id) references public.forecast_runs(tenant_id, id) on delete cascade
);

create index if not exists idx_forecast_runs_tenant_store_requested
  on public.forecast_runs (tenant_id, store_id, requested_at desc);
create index if not exists idx_forecast_runs_queue
  on public.forecast_runs (tenant_id, status, requested_at);
create index if not exists idx_forecast_run_items_tenant_run
  on public.forecast_run_items (tenant_id, run_id, created_at);
create unique index if not exists idx_forecast_runs_active_manual_store
  on public.forecast_runs (tenant_id, store_id)
  where source = 'manual_test' and status in ('queued', 'running');

alter table public.forecast_runs enable row level security;
alter table public.forecast_run_items enable row level security;

drop policy if exists tenant_isolation_forecast_runs on public.forecast_runs;
create policy tenant_isolation_forecast_runs on public.forecast_runs
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

drop policy if exists tenant_isolation_forecast_run_items on public.forecast_run_items;
create policy tenant_isolation_forecast_run_items on public.forecast_run_items
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update on public.forecast_runs to app_runtime;
grant select on public.forecast_run_items to app_runtime;

-- Keep updated_at useful without exposing a general-purpose trigger to clients.
create or replace function public.touch_forecast_run_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke execute on function public.touch_forecast_run_updated_at() from anon, authenticated, public;
drop trigger if exists forecast_runs_touch_updated_at on public.forecast_runs;
create trigger forecast_runs_touch_updated_at
  before update on public.forecast_runs
  for each row execute function public.touch_forecast_run_updated_at();
drop trigger if exists forecast_run_items_touch_updated_at on public.forecast_run_items;
create trigger forecast_run_items_touch_updated_at
  before update on public.forecast_run_items
  for each row execute function public.touch_forecast_run_updated_at();

-- All ML adapters below verify both the tenant setting and the run's store.
-- They are intentionally narrow so adding the queue does not broaden the
-- ml_forecast role's table privileges.

create or replace function public.ml_claim_forecast_run(p_tenant_id uuid)
returns table (
  run_id uuid,
  tenant_id uuid,
  store_id uuid,
  source public.forecast_run_source,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML run claim tenant does not match RLS context' using errcode = '42501';
  end if;

  -- A VM reboot or killed process must not leave the testing control stuck in
  -- "running" forever. The normal worker timeout is 30 minutes; the extra
  -- grace period avoids racing a legitimately slow run.
  update public.forecast_runs
     set status = 'failed', completed_at = now(), error_code = 'worker_timeout',
         error_message = 'The forecast worker stopped reporting progress.'
   where tenant_id = p_tenant_id and status = 'running'
     and coalesce(heartbeat_at, started_at, requested_at) < now() - interval '45 minutes';

  return query
  with candidate as (
    select fr.id
    from public.forecast_runs fr
    where fr.tenant_id = p_tenant_id
      and fr.status = 'queued'
    order by fr.requested_at asc
    for update skip locked
    limit 1
  )
  update public.forecast_runs fr
     set status = 'running', started_at = coalesce(fr.started_at, now()),
         heartbeat_at = now(), error_code = null, error_message = null
    from candidate
   where fr.id = candidate.id
  returning fr.id, fr.tenant_id, fr.store_id, fr.source, fr.requested_at;
end;
$$;

create or replace function public.ml_forecast_run_context(p_tenant_id uuid, p_run_id uuid)
returns table (
  variant_id uuid,
  store_id uuid,
  supplier_id uuid,
  supplier_name text,
  lead_time_days integer,
  review_period_days integer,
  current_stock numeric,
  on_order numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML context tenant does not match RLS context' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.forecast_runs fr
    where fr.id = p_run_id and fr.tenant_id = p_tenant_id and fr.status = 'running'
  ) then
    raise exception 'Forecast run is not active' using errcode = '40901';
  end if;

  return query
  with run_scope as (
    select fr.store_id from public.forecast_runs fr
    where fr.id = p_run_id and fr.tenant_id = p_tenant_id
  ), variants as (
    select distinct dsr.variant_id, rs.store_id
    from public.daily_sales_rollup dsr
    join run_scope rs on rs.store_id = dsr.store_id
    where dsr.tenant_id = p_tenant_id
  ), primary_supplier as (
    select distinct on (sp.variant_id)
      sp.variant_id, sp.supplier_id, s.name supplier_name,
      coalesce(sp.lead_time_days, s.lead_time_days, 7) lead_time_days
    from public.supplier_products sp
    join public.suppliers s on s.id = sp.supplier_id
    where sp.tenant_id = p_tenant_id and s.is_active
    order by sp.variant_id, sp.is_primary desc, sp.created_at asc
  ), inbound as (
    select pol.variant_id, po.store_id,
      sum(greatest(0, pol.quantity_ordered - pol.quantity_received)) on_order
    from public.purchase_order_lines pol
    join public.purchase_orders po on po.id = pol.purchase_order_id
    where pol.tenant_id = p_tenant_id and po.store_id = (select store_id from run_scope)
      and po.status in ('sent', 'partial')
    group by pol.variant_id, po.store_id
  ), fallback_supplier as (
    select s.id supplier_id, s.name supplier_name, s.lead_time_days
    from public.suppliers s
    where s.tenant_id = p_tenant_id and s.is_active
    order by s.name
    limit 1
  )
  select v.variant_id, v.store_id,
         coalesce(ps.supplier_id, fs.supplier_id),
         coalesce(ps.supplier_name, fs.supplier_name),
         coalesce(ps.lead_time_days, fs.lead_time_days, 7), 7,
         coalesce(vsl.quantity, 0), coalesce(i.on_order, 0)
  from variants v
  left join primary_supplier ps on ps.variant_id = v.variant_id
  left join fallback_supplier fs on true
  left join public.variant_stock_levels vsl
    on vsl.tenant_id = p_tenant_id and vsl.variant_id = v.variant_id and vsl.store_id = v.store_id
  left join inbound i on i.variant_id = v.variant_id and i.store_id = v.store_id;
end;
$$;

create or replace function public.ml_write_forecast_run_item(
  p_tenant_id uuid, p_run_id uuid, p_store_id uuid, p_variant_id uuid,
  p_history_days integer, p_trailing_units numeric, p_total_units numeric,
  p_eligible boolean, p_supplier_id uuid, p_supplier_lead_days integer,
  p_review_days integer, p_forecast_horizon_days integer,
  p_rule_based jsonb, p_ml_result jsonb,
  p_disposition public.forecast_run_item_disposition, p_reason_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML item tenant does not match RLS context' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.forecast_runs
    where id = p_run_id and tenant_id = p_tenant_id and store_id = p_store_id and status = 'running'
  ) then
    raise exception 'Forecast run is not active for this store' using errcode = '40901';
  end if;

  insert into public.forecast_run_items(
    tenant_id, run_id, store_id, variant_id, history_days, trailing_units,
    total_units, eligible, supplier_id, supplier_lead_days, review_days,
    forecast_horizon_days, rule_based, ml_result, disposition, reason_code
  ) values (
    p_tenant_id, p_run_id, p_store_id, p_variant_id, p_history_days,
    p_trailing_units, p_total_units, p_eligible, p_supplier_id,
    p_supplier_lead_days, coalesce(p_review_days, 7), p_forecast_horizon_days,
    coalesce(p_rule_based, '{}'::jsonb), coalesce(p_ml_result, '{}'::jsonb),
    p_disposition, p_reason_code
  )
  on conflict (run_id, variant_id) do update set
    history_days = excluded.history_days, trailing_units = excluded.trailing_units,
    total_units = excluded.total_units, eligible = excluded.eligible,
    supplier_id = excluded.supplier_id, supplier_lead_days = excluded.supplier_lead_days,
    review_days = excluded.review_days, forecast_horizon_days = excluded.forecast_horizon_days,
    rule_based = excluded.rule_based, ml_result = excluded.ml_result,
    disposition = excluded.disposition, reason_code = excluded.reason_code,
    updated_at = now();
end;
$$;

create or replace function public.ml_touch_forecast_run(p_tenant_id uuid, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML heartbeat tenant does not match RLS context' using errcode = '42501';
  end if;
  update public.forecast_runs
     set heartbeat_at = now()
   where id = p_run_id and tenant_id = p_tenant_id and status = 'running';
end;
$$;

create or replace function public.ml_complete_forecast_run(
  p_tenant_id uuid, p_run_id uuid, p_products_evaluated integer,
  p_products_eligible integer, p_forecasts_won integer,
  p_forecasts_written integer, p_products_skipped integer,
  p_worker_version text, p_model_version text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML completion tenant does not match RLS context' using errcode = '42501';
  end if;
  update public.forecast_runs
     set status = 'completed', completed_at = now(), heartbeat_at = now(),
         products_evaluated = greatest(0, p_products_evaluated),
         products_eligible = greatest(0, p_products_eligible),
         forecasts_won = greatest(0, p_forecasts_won),
         forecasts_written = greatest(0, p_forecasts_written),
         products_skipped = greatest(0, p_products_skipped),
         worker_version = left(p_worker_version, 128), model_version = left(p_model_version, 128)
   where id = p_run_id and tenant_id = p_tenant_id and status = 'running';
end;
$$;

create or replace function public.ml_fail_forecast_run(
  p_tenant_id uuid, p_run_id uuid, p_error_code text, p_error_message text,
  p_worker_version text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML failure tenant does not match RLS context' using errcode = '42501';
  end if;
  update public.forecast_runs
     set status = 'failed', completed_at = now(), heartbeat_at = now(),
         error_code = left(p_error_code, 80), error_message = left(p_error_message, 1000),
         worker_version = left(p_worker_version, 128)
   where id = p_run_id and tenant_id = p_tenant_id and status = 'running';
end;
$$;

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'ml_claim_forecast_run', 'ml_forecast_run_context',
        'ml_write_forecast_run_item', 'ml_touch_forecast_run',
        'ml_complete_forecast_run', 'ml_fail_forecast_run'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.oid::regprocedure);
    execute format('grant execute on function %s to ml_forecast', fn.oid::regprocedure);
  end loop;
end
$$;

comment on table public.forecast_runs is
  'Temporary/manual and nightly ML run queue. Canonical purchasable output remains reorder_suggestions.';
comment on table public.forecast_run_items is
  'Auditable side-by-side heuristic versus ML comparison for a forecast run.';

commit;
