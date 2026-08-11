create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  staff_id uuid not null references public.staff_members(id),
  starting_cash numeric(12,2) not null,
  opened_at timestamptz not null default now(),
  counted_cash numeric(12,2),
  variance numeric(12,2),
  closed_at timestamptz
);

create index idx_shifts_tenant_id on public.shifts(tenant_id);
create index idx_shifts_staff_id on public.shifts(staff_id);

alter table public.shifts enable row level security;

create policy tenant_isolation_shifts on public.shifts
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- D-15/D-16: unlike the append-only ledger tables, a shift row is mutated
-- once (at close: counted_cash/variance/closed_at) -- this is the one place
-- this phase's schema needs an UPDATE grant, not pure append-only.
grant select, insert, update on public.shifts to app_runtime;
