begin;

create table if not exists public.private_billing_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  region text not null check (region in ('IN', 'INTL')),
  base_plan_key text not null,
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual')),
  currency text not null check (currency in ('INR', 'USD')),
  negotiated_base_amount_minor bigint not null check (negotiated_base_amount_minor > 0),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  tax_amount_minor bigint not null check (tax_amount_minor >= 0),
  total_amount_minor bigint not null check (total_amount_minor > 0),
  included_location_count integer not null check (included_location_count > 0),
  included_register_count integer not null check (included_register_count > 0),
  included_user_count integer not null check (included_user_count > 0),
  additional_location_unit_amount_minor bigint not null default 0 check (additional_location_unit_amount_minor >= 0),
  additional_register_unit_amount_minor bigint not null default 0 check (additional_register_unit_amount_minor >= 0),
  additional_user_unit_amount_minor bigint not null default 0 check (additional_user_unit_amount_minor >= 0),
  trial_days integer not null default 0 check (trial_days between 0 and 365),
  latest_activation_at timestamptz not null,
  price_validity text not null default 'until_changed' check (price_validity in ('until_changed', 'fixed_cycles')),
  fixed_billing_cycles integer check (fixed_billing_cycles is null or fixed_billing_cycles > 0),
  provider_plan_id text,
  provider_mode text not null check (provider_mode in ('test', 'live')),
  status text not null default 'provisioning' check (status in ('provisioning', 'offered', 'accepted', 'expired', 'withdrawn', 'provisioning_failed')),
  internal_reason text not null,
  sales_reference text,
  created_by uuid not null references public.platform_admins(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (latest_activation_at > created_at),
  check ((price_validity = 'fixed_cycles') = (fixed_billing_cycles is not null))
);

create index if not exists idx_private_billing_offers_tenant_status
  on public.private_billing_offers (tenant_id, status, created_at desc);
create unique index if not exists uq_private_billing_offers_provider_plan
  on public.private_billing_offers (provider_plan_id)
  where provider_plan_id is not null;

alter table public.private_billing_offers enable row level security;
revoke all on public.private_billing_offers from anon, authenticated, public;
create policy private_billing_offers_service_role on public.private_billing_offers
  for all to service_role using (true) with check (true);
create policy private_billing_offers_merchant_read on public.private_billing_offers
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on public.private_billing_offers to service_role;
grant select on public.private_billing_offers to app_runtime;

alter table public.billing_trials drop constraint if exists billing_trials_status_check;
alter table public.billing_trials add constraint billing_trials_status_check
  check (status in ('pending', 'active', 'expired', 'cancelled'));
alter table public.billing_trials add column if not exists private_offer_id uuid references public.private_billing_offers(id) on delete set null;
alter table public.billing_trials add column if not exists latest_activation_at timestamptz;
alter table public.billing_trials add column if not exists activated_at timestamptz;
alter table public.billing_trials add column if not exists additional_store_count integer not null default 0 check (additional_store_count >= 0);
alter table public.billing_trials add column if not exists additional_register_count integer not null default 0 check (additional_register_count >= 0);
alter table public.billing_trials add column if not exists additional_user_count integer not null default 0 check (additional_user_count >= 0);
drop index if exists public.uq_billing_trials_active_tenant;
create unique index uq_billing_trials_open_tenant on public.billing_trials (tenant_id)
  where status in ('pending', 'active');

alter table public.billing_subscriptions add column if not exists private_offer_id uuid references public.private_billing_offers(id) on delete set null;
create index if not exists idx_billing_subscriptions_private_offer on public.billing_subscriptions (private_offer_id)
  where private_offer_id is not null;
alter table public.billing_subscription_attempts add column if not exists private_offer_id uuid references public.private_billing_offers(id) on delete set null;
create index if not exists idx_billing_attempts_private_offer on public.billing_subscription_attempts (private_offer_id)
  where private_offer_id is not null;

comment on table public.private_billing_offers is
  'Tenant-specific negotiated recurring offers. Provider plans and accepted price snapshots are immutable; later increases require a new owner-authorised offer.';

commit;
