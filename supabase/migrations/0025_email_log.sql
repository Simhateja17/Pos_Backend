-- COMMS-01 — email send log, bounces and unsubscribes.
--
-- Why this table exists: a receipt that silently failed is a support call with
-- no evidence. The owner needs to be able to answer "did the customer get it?"
-- without access to the provider's dashboard, so every send attempt is recorded
-- here with its outcome, including the ones that never left the building.
--
-- Email only. No SMS, no WhatsApp in V1 — the nav's WhatsApp Connect entry
-- stays an unavailable module.

begin;

create table public.email_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- 'receipt' and 'invoice' are transactional; 'offer' is marketing and is the
  -- only kind an unsubscribe suppresses. Conflating the two would either spam
  -- people who opted out or withhold a receipt someone paid for.
  kind text not null,
  recipient text not null,
  subject text not null,
  status text not null default 'queued',
  -- Provider message id, so a send here can be traced in the provider's own logs.
  provider_message_id text,
  error_message text,
  -- What the email was about, when there is something to point at.
  sale_id uuid references public.sales(id) on delete set null,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  created_by uuid references public.staff_members(id) on delete set null,
  created_at timestamptz not null default now(),
  check (kind in ('receipt', 'invoice', 'offer')),
  check (status in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  check (attempts >= 0)
);

create index idx_email_log_tenant_created on public.email_log(tenant_id, created_at desc);
create index idx_email_log_tenant_status on public.email_log(tenant_id, status);
create index idx_email_log_sale on public.email_log(sale_id) where sale_id is not null;
create index idx_email_log_recipient on public.email_log(tenant_id, lower(recipient));

comment on table public.email_log is
  'COMMS-01: one row per send attempt, including attempts suppressed before sending. The evidence trail for "did the receipt arrive?".';

alter table public.email_log enable row level security;

create policy tenant_isolation_email_log on public.email_log
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on public.email_log to app_runtime;

-- ---------------------------------------------------------------------------
-- Suppression list: hard bounces, complaints, and explicit unsubscribes.
--
-- Keyed on lower(email) per tenant. One address, one row — a second bounce
-- updates the existing row rather than accumulating duplicates, so a lookup on
-- the send path is a single index hit.

create table public.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  -- 'unsubscribed' is the customer's choice and suppresses marketing only.
  -- 'bounced'/'complained' are deliverability facts and suppress everything —
  -- continuing to send to a hard-bouncing address damages the sending domain
  -- for every other customer of this store.
  reason text not null,
  detail text,
  created_at timestamptz not null default now(),
  check (reason in ('unsubscribed', 'bounced', 'complained'))
);

create unique index idx_email_suppressions_tenant_email
  on public.email_suppressions(tenant_id, lower(email));

comment on table public.email_suppressions is
  'COMMS-01: addresses we must not email. unsubscribed suppresses marketing only; bounced/complained suppress everything.';

alter table public.email_suppressions enable row level security;

create policy tenant_isolation_email_suppressions on public.email_suppressions
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on public.email_suppressions to app_runtime;

commit;
