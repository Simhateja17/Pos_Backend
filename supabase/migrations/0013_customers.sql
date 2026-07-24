-- CUST-01: a walk-in sale with no phone/email never creates a row (checked at
-- the check constraint AND app layer, since the sale may still complete with
-- customer_id null). Unique partial indexes on (tenant_id, phone)/(tenant_id,
-- lower(email)) back the find-or-create dedup lookup (RESEARCH.md Pitfall 5)
-- at the DB level, not just app-layer discipline.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text,
  phone text,
  email text,
  created_at timestamptz not null default now(),
  check (phone is not null or email is not null)
);

create unique index idx_customers_tenant_phone on public.customers(tenant_id, phone) where phone is not null;
create unique index idx_customers_tenant_email on public.customers(tenant_id, lower(email)) where email is not null;
create index idx_customers_tenant_id on public.customers(tenant_id);

alter table public.customers enable row level security;

create policy tenant_isolation_customers on public.customers
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on public.customers to app_runtime;
