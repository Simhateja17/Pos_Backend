alter table public.tenants enable row level security;
alter table public.staff_members enable row level security;

-- D-01/D-02: owner has the SAME RLS posture as manager/cashier — no role-based exception here.
-- Role gating for sensitive actions happens at the Express layer (requireRole middleware), not RLS.
create policy tenant_isolation_tenants on public.tenants
  for all
  using (id = current_setting('app.tenant_id', true)::uuid)
  with check (id = current_setting('app.tenant_id', true)::uuid);

create policy tenant_isolation_staff_members on public.staff_members
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- current_setting(..., true) — the `true` "missing_ok" flag returns NULL instead of raising when
-- app.tenant_id is unset, so an unscoped connection sees zero rows rather than erroring;
-- NULL = anything is never true, satisfying default-deny.
