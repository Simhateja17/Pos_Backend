-- Task 4: per-variant daily sales rollup.
--
-- THIS TABLE'S SHAPE IS A CONTRACT. Phase 6's statsforecast job reads this and
-- nothing else, so columns here should be added, never repurposed.
--
-- Populated by TRIGGER on sale line insert, not by a nightly job. The deciding
-- reason is Phase 4: sales are queued offline and sync late, sometimes days
-- late. A nightly job keyed on "yesterday" would silently miss a sale that
-- arrived after its window closed, and the gap would never self-heal. A trigger
-- attributes each line to the date of ITS OWN sale whenever the row lands, so a
-- late-syncing sale still books to the day it actually happened.
--
-- Cost: the rollup is only as complete as `sales`. That is the right trade --
-- it can never drift from the ledger it is derived from.

begin;

-- Day boundaries must be the retailer's own, not UTC. A 9pm sale in Hyderabad
-- is 15:30 UTC the same day, but a 2am sale is 20:30 UTC the PREVIOUS day --
-- bucketing on UTC would move it to the wrong day, and Phase 6 reads a daily
-- series where that is a real error, not a rounding artefact.
alter table public.tenants add column timezone text not null default 'UTC';

update public.tenants set timezone = 'Asia/Kolkata' where country = 'IN';
update public.tenants set timezone = 'America/New_York' where country = 'US';

comment on column public.tenants.timezone is
  'IANA timezone used to assign sales to a business day in daily_sales_rollup. Seeded from country; US tenants outside Eastern must correct this.';

create table public.daily_sales_rollup (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete cascade,
  date date not null,
  units_sold integer not null default 0,
  revenue numeric(12, 2) not null default 0,
  -- Units returned, booked on the date the RETURN happened, not the date of
  -- the original sale. Velocity is about what is leaving the shelf now; a
  -- return three weeks later does not change what sold three weeks ago, it
  -- changes what is on hand today.
  returns_units integer not null default 0,
  primary key (tenant_id, variant_id, date)
);

create index idx_daily_sales_rollup_tenant_date on public.daily_sales_rollup(tenant_id, date);
create index idx_daily_sales_rollup_variant on public.daily_sales_rollup(variant_id, date);

-- ---------------------------------------------------------------------------
-- Sale lines -> units_sold / revenue

create or replace function public.apply_sale_line_to_rollup() returns trigger as $$
declare
  business_date date;
begin
  select (s.created_at at time zone t.timezone)::date
    into business_date
  from public.sales s
  join public.tenants t on t.id = s.tenant_id
  where s.id = new.sale_id;

  insert into public.daily_sales_rollup (tenant_id, variant_id, date, units_sold, revenue)
  values (new.tenant_id, new.variant_id, business_date, new.quantity, new.line_total)
  on conflict (tenant_id, variant_id, date) do update
    set units_sold = daily_sales_rollup.units_sold + excluded.units_sold,
        revenue = daily_sales_rollup.revenue + excluded.revenue;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_apply_sale_line_to_rollup
  after insert on public.sale_line_items
  for each row execute function public.apply_sale_line_to_rollup();

-- ---------------------------------------------------------------------------
-- Return movements -> returns_units
--
-- Returns are written as `return` stock movements by returns.ts, so that is
-- where this hooks. Only `return` movements count: a `receive` is stock coming
-- in from a supplier and an `adjustment` is a count correction, neither of
-- which is customer demand.

create or replace function public.apply_return_to_rollup() returns trigger as $$
declare
  business_date date;
begin
  if new.movement_type <> 'return' then
    return new;
  end if;

  select (new.created_at at time zone t.timezone)::date
    into business_date
  from public.tenants t where t.id = new.tenant_id;

  insert into public.daily_sales_rollup (tenant_id, variant_id, date, returns_units)
  values (new.tenant_id, new.variant_id, business_date, new.quantity_delta)
  on conflict (tenant_id, variant_id, date) do update
    set returns_units = daily_sales_rollup.returns_units + excluded.returns_units;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_apply_return_to_rollup
  after insert on public.stock_movements
  for each row execute function public.apply_return_to_rollup();

-- ---------------------------------------------------------------------------
-- Backfill from existing history, so the rollup is not empty on day one and
-- the heuristic has something real to work with immediately.

insert into public.daily_sales_rollup (tenant_id, variant_id, date, units_sold, revenue)
select
  sli.tenant_id,
  sli.variant_id,
  (s.created_at at time zone t.timezone)::date as business_date,
  sum(sli.quantity),
  sum(sli.line_total)
from public.sale_line_items sli
join public.sales s on s.id = sli.sale_id
join public.tenants t on t.id = sli.tenant_id
group by sli.tenant_id, sli.variant_id, business_date
on conflict (tenant_id, variant_id, date) do update
  set units_sold = excluded.units_sold, revenue = excluded.revenue;

insert into public.daily_sales_rollup (tenant_id, variant_id, date, returns_units)
select
  sm.tenant_id,
  sm.variant_id,
  (sm.created_at at time zone t.timezone)::date as business_date,
  sum(sm.quantity_delta)
from public.stock_movements sm
join public.tenants t on t.id = sm.tenant_id
where sm.movement_type = 'return'
group by sm.tenant_id, sm.variant_id, business_date
on conflict (tenant_id, variant_id, date) do update
  set returns_units = excluded.returns_units;

-- ---------------------------------------------------------------------------
-- RLS. Read-only to the app: every write comes from the triggers above, which
-- run SECURITY DEFINER. Granting insert/update would let app code write a
-- number that disagrees with the sales ledger.

alter table public.daily_sales_rollup enable row level security;

create policy tenant_isolation_daily_sales_rollup on public.daily_sales_rollup
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select on public.daily_sales_rollup to app_runtime;

commit;
