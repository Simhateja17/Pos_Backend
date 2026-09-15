-- Plan changes (upgrade / downgrade / renew after cancellation).
--
-- Razorpay cannot change the plan of a UPI Autopay or eMandate subscription in
-- place, so a plan change is a *new* provider subscription that the owner
-- authorises, followed by ending the old one. For a short window a tenant can
-- therefore hold two open provider subscriptions: the live one and a pending
-- successor. The successor is flagged `switch_pending` and is never read as the
-- tenant's entitlement until it is promoted.

ALTER TABLE public.billing_subscription_attempts
  ADD COLUMN IF NOT EXISTS replaces_subscription_id UUID REFERENCES public.billing_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS switch_kind TEXT CHECK (switch_kind IN ('upgrade', 'downgrade', 'renewal'));

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS replaces_subscription_id UUID REFERENCES public.billing_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS switch_kind TEXT CHECK (switch_kind IN ('upgrade', 'downgrade', 'renewal')),
  ADD COLUMN IF NOT EXISTS switch_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS switch_starts_at TIMESTAMPTZ;

-- One live subscription per tenant, as before, but a pending successor is not live.
DROP INDEX IF EXISTS public.uq_billing_subscriptions_open_tenant;
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscriptions_open_tenant
  ON public.billing_subscriptions (tenant_id)
  WHERE status IN ('created', 'authenticated', 'active', 'pending', 'halted') AND NOT switch_pending;

-- And at most one pending successor per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscriptions_pending_switch_tenant
  ON public.billing_subscriptions (tenant_id)
  WHERE status IN ('created', 'authenticated', 'active', 'pending', 'halted') AND switch_pending;
