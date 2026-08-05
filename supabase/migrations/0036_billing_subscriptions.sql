-- Merchant SaaS subscription billing.
--
-- Razorpay is the provider of record for recurring charges. These tables keep
-- the tenant-scoped entitlement and the provider references needed to
-- reconcile Checkout callbacks and webhooks without trusting the browser.

CREATE TABLE IF NOT EXISTS public.billing_subscription_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('IN', 'US')),
  plan_key TEXT NOT NULL,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
  currency TEXT NOT NULL CHECK (currency IN ('INR', 'USD')),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor >= 0),
  tax_amount_minor BIGINT NOT NULL CHECK (tax_amount_minor >= 0),
  total_amount_minor BIGINT NOT NULL CHECK (total_amount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
  provider_plan_id TEXT NOT NULL,
  provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN (
    'creating', 'created', 'verification_pending', 'active', 'failed', 'expired'
  )),
  failure_code TEXT,
  failure_message TEXT,
  provider_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_attempts_tenant_created
  ON public.billing_subscription_attempts (tenant_id, created_at DESC);

ALTER TABLE public.billing_subscription_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_attempts_tenant_isolation ON public.billing_subscription_attempts;
CREATE POLICY billing_attempts_tenant_isolation
  ON public.billing_subscription_attempts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON public.billing_subscription_attempts TO app_runtime;

CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES public.billing_subscription_attempts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'razorpay' CHECK (provider = 'razorpay'),
  provider_subscription_id TEXT NOT NULL UNIQUE,
  provider_plan_id TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('IN', 'US')),
  plan_key TEXT NOT NULL,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
  currency TEXT NOT NULL CHECK (currency IN ('INR', 'USD')),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor >= 0),
  tax_amount_minor BIGINT NOT NULL CHECK (tax_amount_minor >= 0),
  total_amount_minor BIGINT NOT NULL CHECK (total_amount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired'
  )),
  entitlement_status TEXT NOT NULL DEFAULT 'blocked' CHECK (entitlement_status IN (
    'blocked', 'active', 'grace'
  )),
  cancel_at_cycle_end BOOLEAN NOT NULL DEFAULT FALSE,
  current_start_at TIMESTAMPTZ,
  current_end_at TIMESTAMPTZ,
  grace_until_at TIMESTAMPTZ,
  last_payment_id TEXT,
  last_invoice_id TEXT,
  provider_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_tenant_updated
  ON public.billing_subscriptions (tenant_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscriptions_open_tenant
  ON public.billing_subscriptions (tenant_id)
  WHERE status IN ('created', 'authenticated', 'active', 'pending', 'halted');

ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_subscriptions_tenant_isolation ON public.billing_subscriptions;
CREATE POLICY billing_subscriptions_tenant_isolation
  ON public.billing_subscriptions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON public.billing_subscriptions TO app_runtime;

CREATE TABLE IF NOT EXISTS public.billing_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES public.billing_subscriptions(id) ON DELETE CASCADE,
  provider_payment_id TEXT UNIQUE,
  provider_invoice_id TEXT UNIQUE,
  provider_event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'authorization', 'refund')),
  status TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('INR', 'USD')),
  provider_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_transactions_tenant_created
  ON public.billing_transactions (tenant_id, created_at DESC);

ALTER TABLE public.billing_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_transactions_tenant_isolation ON public.billing_transactions;
CREATE POLICY billing_transactions_tenant_isolation
  ON public.billing_transactions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON public.billing_transactions TO app_runtime;

-- Webhook event IDs are provider-global, so this ingress ledger cannot use
-- tenant_id-based RLS. It is still RLS-protected: only the backend runtime
-- role may access it, and Supabase anon/authenticated API roles are denied.
CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_created
  ON public.billing_webhook_events (created_at DESC);
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_webhook_events_runtime_only ON public.billing_webhook_events;
CREATE POLICY billing_webhook_events_runtime_only
  ON public.billing_webhook_events
  FOR ALL TO app_runtime
  USING (true)
  WITH CHECK (true);
REVOKE ALL ON public.billing_webhook_events FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.billing_webhook_events TO app_runtime;

CREATE OR REPLACE FUNCTION public.touch_billing_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS billing_attempts_touch_updated_at ON public.billing_subscription_attempts;
CREATE TRIGGER billing_attempts_touch_updated_at
  BEFORE UPDATE ON public.billing_subscription_attempts
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_updated_at();

DROP TRIGGER IF EXISTS billing_subscriptions_touch_updated_at ON public.billing_subscriptions;
CREATE TRIGGER billing_subscriptions_touch_updated_at
  BEFORE UPDATE ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_updated_at();

DROP TRIGGER IF EXISTS billing_transactions_touch_updated_at ON public.billing_transactions;
CREATE TRIGGER billing_transactions_touch_updated_at
  BEFORE UPDATE ON public.billing_transactions
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_updated_at();
