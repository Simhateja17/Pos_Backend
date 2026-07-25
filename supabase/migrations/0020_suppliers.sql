-- PUR-01: supplier master. lead_time_days is not administrative trivia — it is
-- a direct input to the Phase 5 reorder formula (reorder_point = daily_velocity
-- * lead_time_days + safety_stock), so it is NOT NULL with a conservative
-- default rather than optional.
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  contact_name text,
  email text,
  phone text,
  address text,
  lead_time_days integer not null default 7,
  min_order_value numeric(12, 2),
  payment_terms text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (lead_time_days > 0),
  check (min_order_value is null or min_order_value >= 0)
);

create index idx_suppliers_tenant_id on public.suppliers(tenant_id);

alter table public.suppliers enable row level security;

create policy tenant_isolation_suppliers on public.suppliers
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on public.suppliers to app_runtime;
