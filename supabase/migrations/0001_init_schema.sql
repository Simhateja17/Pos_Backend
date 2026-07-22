-- Tenants (tenant = store, 1:1 for V1 — D-01). Business/tax profile fields captured at signup (D-06).
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  state text not null,
  postal_code text not null,
  country text not null default 'US',
  tax_id text,
  -- D-14: per-tenant configurable discount threshold requiring manager+ approval above this percent.
  -- Default 15% is a placeholder sane default, not a researched retail-industry figure (RESEARCH.md Open Question #2).
  discount_threshold_percent numeric(5,2) not null default 15.00,
  created_at timestamptz not null default now()
);

-- Staff members (D-03: multiple owners allowed per tenant, no unique-owner constraint).
create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  role text not null check (role in ('owner', 'manager', 'cashier')),
  -- PIN-switch (D-09/D-10): 4-digit PIN, bcrypt-hashed, never plaintext (Security Domain V6).
  -- pin_hash starts NULL at invite time; it is populated the first time the invited staff
  -- member completes account activation and calls POST /auth/set-pin (see plan 01-13) —
  -- until then that staff member cannot yet PIN-switch (expected, not a bug).
  pin_hash text,
  pin_attempts int not null default 0,
  pin_locked_until timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_staff_members_tenant_id on public.staff_members(tenant_id);
create index idx_staff_members_user_id on public.staff_members(user_id);

-- Dedicated restricted role for runtime app traffic (RESEARCH.md Pitfall 1 / Anti-Patterns).
-- NOBYPASSRLS is the default for a freshly created role (only superusers get BYPASSRLS) — explicit here for clarity.
-- Password is a placeholder; MUST be rotated via `ALTER ROLE app_runtime WITH PASSWORD '<real-secret>'`
-- through the Supabase SQL editor or CLI BEFORE production use — never commit the real password to a migration file.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login password 'CHANGE_ME_VIA_ALTER_ROLE' nobypassrls;
  end if;
end
$$;

grant usage on schema public to app_runtime;
grant select, insert, update, delete on public.tenants, public.staff_members to app_runtime;
-- Future tenant-owned tables (Phase 2+) must repeat this grant in their own migration.
