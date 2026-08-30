-- 0071 — regional Ambel Admin control plane.
--
-- These tables deliberately live in each regional Supabase project.  They are
-- not an extension of merchant staff_members: a platform administrator is an
-- Ambel employee, has no tenant membership, and is resolved only by the
-- regional backend's privileged adapter.

begin;

-- Merchant Owners need an in-product consent prompt.  This extends the
-- existing tenant notification vocabulary without exposing any admin data.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('business_type_unset', 'po_received', 'staff_activated', 'stock_low', 'support_access_request'));

create table if not exists public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  email text not null,
  display_name text not null,
  role text not null check (role in ('platform_owner', 'support_admin', 'read_only')),
  -- Every copy of this table is fixed to the project it was migrated into.
  -- The backend still checks this value on every request; it is not client
  -- supplied and is not a region switch.
  region text not null check (region in ('IN', 'INTL')),
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended')),
  invited_by uuid references public.platform_admins(id) on delete set null,
  invited_at timestamptz not null default now(),
  activated_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_platform_admins_active_email
  on public.platform_admins (lower(email))
  where status in ('invited', 'active');
create index if not exists idx_platform_admins_region_status
  on public.platform_admins (region, status);

create table if not exists public.admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  administrator_id uuid references public.platform_admins(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  tenant_id uuid references public.tenants(id) on delete set null,
  ticket_id text,
  reason text,
  request_id text,
  ip_address inet,
  user_agent text,
  before_summary jsonb,
  after_summary jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_audit_events_created
  on public.admin_audit_events (created_at desc);
create index if not exists idx_admin_audit_events_admin_created
  on public.admin_audit_events (administrator_id, created_at desc);
create index if not exists idx_admin_audit_events_tenant_created
  on public.admin_audit_events (tenant_id, created_at desc);

create table if not exists public.support_access_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  merchant_owner_id uuid not null references public.staff_members(id) on delete restrict,
  requested_by uuid not null references public.platform_admins(id) on delete restrict,
  ticket_id text not null,
  reason text not null,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'denied', 'expired', 'terminated')),
  approved_at timestamptz,
  expires_at timestamptz,
  terminated_at timestamptz,
  terminated_by uuid references public.platform_admins(id) on delete set null,
  session_token_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_support_access_requests_tenant_created
  on public.support_access_requests (tenant_id, created_at desc);
create index if not exists idx_support_access_requests_admin_status
  on public.support_access_requests (requested_by, status, created_at desc);

create table if not exists public.admin_entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entitlement_key text not null,
  override_value jsonb not null,
  justification text not null,
  ticket_id text not null,
  created_by uuid not null references public.platform_admins(id) on delete restrict,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.platform_admins(id) on delete set null,
  revocation_reason text,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index if not exists idx_admin_entitlement_overrides_tenant_active
  on public.admin_entitlement_overrides (tenant_id, expires_at)
  where revoked_at is null;

-- A retry is itself an audited, idempotent operation.  It is intentionally a
-- small control-plane ledger rather than an arbitrary job runner: the API only
-- accepts operation kinds with an established key/contract.
create table if not exists public.admin_operation_retries (
  id uuid primary key default gen_random_uuid(),
  operation_kind text not null check (operation_kind in ('webhook', 'email', 'import', 'forecast')),
  operation_id text not null,
  idempotency_key text not null,
  requested_by uuid not null references public.platform_admins(id) on delete restrict,
  status text not null default 'queued' check (status in ('queued', 'replayed', 'rejected')),
  result_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operation_kind, idempotency_key)
);
create index if not exists idx_admin_operation_retries_created
  on public.admin_operation_retries (created_at desc);

-- Browser roles have no privilege on any control-plane table.  service_role is
-- the only database adapter allowed to cross tenant boundaries; app_runtime
-- gets only the merchant-consent slice, scoped by its normal tenant RLS.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'platform_admins',
    'admin_audit_events',
    'support_access_requests',
    'admin_entitlement_overrides',
    'admin_operation_retries'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated, public', table_name);
  end loop;
end
$$;

create policy platform_admins_service_role_only on public.platform_admins
  for all to service_role using (true) with check (true);
create policy admin_audit_events_service_role_only on public.admin_audit_events
  for select to service_role using (true);
create policy admin_audit_events_service_role_insert on public.admin_audit_events
  for insert to service_role with check (true);
create policy support_access_requests_service_role on public.support_access_requests
  for all to service_role using (true) with check (true);
create policy admin_entitlement_overrides_service_role on public.admin_entitlement_overrides
  for all to service_role using (true) with check (true);
create policy admin_operation_retries_service_role on public.admin_operation_retries
  for all to service_role using (true) with check (true);

-- The merchant account can see and decide requests for its own tenant.  It
-- cannot create a request or read any platform-admin/audit data.
create policy support_access_requests_merchant_read on public.support_access_requests
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy support_access_requests_merchant_decide on public.support_access_requests
  for update to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update on public.platform_admins to service_role;
grant select, insert on public.admin_audit_events to service_role;
grant select, insert, update on public.support_access_requests to service_role;
grant select, insert, update on public.support_access_requests to app_runtime;
grant select, insert, update on public.admin_entitlement_overrides to service_role;
grant select, insert, update on public.admin_operation_retries to service_role;

comment on table public.platform_admins is
  'Regional Ambel employees only. Never expose through browser CRUD or merchant staff APIs.';
comment on table public.admin_audit_events is
  'Append-only regional platform-admin audit ledger. No update/delete grant is intentional.';
comment on table public.support_access_requests is
  'Merchant-consented, time-bounded read-only support access. It is not impersonation.';

commit;
