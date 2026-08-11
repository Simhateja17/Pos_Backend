-- 0057 — India MVP plan snapshots and tenant-local entitlement metering.
--
-- The application catalogue is the source for new plan presentation, but a
-- subscription must retain the limits that were purchased. The snapshot and
-- usage writes therefore have database boundaries as well as service helpers;
-- a later catalogue edit cannot silently reprice an existing tenant.

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS entitlement_version text NOT NULL DEFAULT 'india-mvp-04-v1',
  ADD COLUMN IF NOT EXISTS entitlement_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'billing_subscriptions_entitlement_snapshot_object'
  ) THEN
    ALTER TABLE public.billing_subscriptions
      ADD CONSTRAINT billing_subscriptions_entitlement_snapshot_object
      CHECK (jsonb_typeof(entitlement_snapshot) = 'object');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_billing_entitlement_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- billing.ts still passes only plan_key to the legacy denormalised store
  -- column. Keep the colliding US Professional key region-correct at the
  -- database boundary so the older store trigger cannot persist India's
  -- three-location allowance for a five-location US subscription.
  IF TG_TABLE_NAME = 'billing_subscriptions' THEN
    IF NEW.region = 'US' AND NEW.plan_key = 'professional' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 5);
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.entitlement_snapshot IS DISTINCT FROM '{}'::jsonb
    AND NEW.entitlement_snapshot IS DISTINCT FROM OLD.entitlement_snapshot THEN
    RAISE EXCEPTION 'entitlement snapshots are immutable once populated';
  END IF;

  IF NEW.entitlement_snapshot IS NULL OR NEW.entitlement_snapshot = '{}'::jsonb THEN
    NEW.entitlement_version := 'india-mvp-04-v1';
    NEW.entitlement_snapshot := CASE
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'standard' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'standard', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 1, 'maxActiveUsers', 3, 'maxActiveRegisters', 1,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 500,
          'monthlyEcommerceOrders', 500, 'monthlyPurchaseOrders', 500,
          'monthlyBills', 500, 'dailyApiCalls', 2500, 'integrations', 0
        )
      )
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'professional' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'professional', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 3, 'maxActiveUsers', 10, 'maxActiveRegisters', 3,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 5000,
          'monthlyEcommerceOrders', 5000, 'monthlyPurchaseOrders', 2500,
          'monthlyBills', 2500, 'dailyApiCalls', 5000, 'integrations', 0
        )
      )
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'premium' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'premium', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 5, 'maxActiveUsers', 15, 'maxActiveRegisters', 5,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 10000,
          'monthlyEcommerceOrders', 10000, 'monthlyPurchaseOrders', 5000,
          'monthlyBills', 5000, 'dailyApiCalls', 7500, 'integrations', 0
        )
      )
      WHEN NEW.region = 'US' AND NEW.plan_key = 'professional' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'professional', 'region', 'US', 'limits', jsonb_build_object(
          'maxLocations', 5, 'maxActiveUsers', 'unlimited', 'maxActiveRegisters', 'unlimited',
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'US' AND NEW.plan_key = 'essentials' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'essentials', 'region', 'US', 'limits', jsonb_build_object(
          'maxLocations', 1, 'maxActiveUsers', 'unlimited', 'maxActiveRegisters', 'unlimited',
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'IN' AND NEW.plan_key IN ('starter', 'free') THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'free', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 1, 'maxActiveUsers', 1, 'maxActiveRegisters', 1,
          'monthlyPosTransactions', 50, 'monthlySalesOrders', 50,
          'monthlyEcommerceOrders', 50, 'monthlyPurchaseOrders', 20,
          'monthlyBills', 20, 'dailyApiCalls', 1500, 'integrations', 0
        )
      )
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'growth' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'professional', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 3, 'maxActiveUsers', 10, 'maxActiveRegisters', 3,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 5000,
          'monthlyEcommerceOrders', 5000, 'monthlyPurchaseOrders', 2500,
          'monthlyBills', 2500, 'dailyApiCalls', 5000, 'integrations', 0
        )
      )
      WHEN NEW.region = 'US' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'essentials', 'region', 'US', 'limits', jsonb_build_object(
          'maxLocations', 1, 'maxActiveUsers', 'unlimited', 'maxActiveRegisters', 'unlimited',
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      ELSE jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'free', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 1, 'maxActiveUsers', 1, 'maxActiveRegisters', 1,
          'monthlyPosTransactions', 50, 'monthlySalesOrders', 50,
          'monthlyEcommerceOrders', 50, 'monthlyPurchaseOrders', 20,
          'monthlyBills', 20, 'dailyApiCalls', 1500, 'integrations', 0
        )
      )
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_billing_entitlement_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_billing_entitlement_snapshot() FROM anon;
REVOKE ALL ON FUNCTION public.set_billing_entitlement_snapshot() FROM authenticated;

DROP TRIGGER IF EXISTS billing_subscriptions_set_entitlement_snapshot ON public.billing_subscriptions;
CREATE TRIGGER billing_subscriptions_set_entitlement_snapshot
  BEFORE INSERT OR UPDATE OF entitlement_snapshot ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_billing_entitlement_snapshot();

-- Backfill current rows through the same trigger so existing subscribers have
-- a durable projection before the application starts reading it.
UPDATE public.billing_subscriptions
SET entitlement_snapshot = '{}'::jsonb
WHERE entitlement_snapshot = '{}'::jsonb;

-- Preserve the already-purchased store allowance, including the defensive
-- widening performed by 0053 for tenants that had more active shops than the
-- old catalogue. The new snapshot is still the authority for all other keys.
-- This is the one migration-time rewrite before the trigger's immutability
-- boundary applies to populated snapshots.
ALTER TABLE public.billing_subscriptions DISABLE TRIGGER billing_subscriptions_set_entitlement_snapshot;
UPDATE public.billing_subscriptions
SET entitlement_snapshot = jsonb_set(
  entitlement_snapshot,
  '{limits,maxLocations}',
  to_jsonb(greatest(
    included_store_count,
    CASE
      WHEN (entitlement_snapshot #>> '{limits,maxLocations}') ~ '^[0-9]+$'
        THEN (entitlement_snapshot #>> '{limits,maxLocations}')::integer
      ELSE 1
    END
  )),
  true
)
WHERE jsonb_typeof(entitlement_snapshot #> '{limits,maxLocations}') = 'number';
UPDATE public.billing_subscriptions
SET included_store_count = greatest(included_store_count, 5)
WHERE region = 'US' AND plan_key = 'professional';
ALTER TABLE public.billing_subscriptions ENABLE TRIGGER billing_subscriptions_set_entitlement_snapshot;

-- Trials are intentionally separate from provider subscriptions. This keeps
-- an expired trial from looking like a paid Razorpay subscription while still
-- allowing the same snapshot/access resolver to govern both sources.
CREATE TABLE IF NOT EXISTS public.billing_trials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  region text NOT NULL CHECK (region IN ('IN', 'US')),
  plan_key text NOT NULL,
  entitlement_version text NOT NULL DEFAULT 'india-mvp-04-v1',
  entitlement_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_trials_snapshot_object CHECK (jsonb_typeof(entitlement_snapshot) = 'object'),
  CONSTRAINT billing_trials_dates_valid CHECK (ends_at IS NULL OR ends_at > started_at)
);

CREATE INDEX IF NOT EXISTS idx_billing_trials_tenant_started
  ON public.billing_trials (tenant_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_trials_active_tenant
  ON public.billing_trials (tenant_id)
  WHERE status = 'active';

ALTER TABLE public.billing_trials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_trials_tenant_isolation ON public.billing_trials;
CREATE POLICY billing_trials_tenant_isolation
  ON public.billing_trials
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON public.billing_trials TO app_runtime;

DROP TRIGGER IF EXISTS billing_trials_set_entitlement_snapshot ON public.billing_trials;
CREATE TRIGGER billing_trials_set_entitlement_snapshot
  BEFORE INSERT OR UPDATE OF entitlement_snapshot ON public.billing_trials
  FOR EACH ROW EXECUTE FUNCTION public.set_billing_entitlement_snapshot();

-- The same snapshot trigger accepts a trial row because it only depends on
-- region/plan_key/entitlement_snapshot. Its updated_at is maintained locally.
CREATE OR REPLACE FUNCTION public.touch_billing_trial_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_billing_trial_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_billing_trial_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.touch_billing_trial_updated_at() FROM authenticated;

DROP TRIGGER IF EXISTS billing_trials_touch_updated_at ON public.billing_trials;
CREATE TRIGGER billing_trials_touch_updated_at
  BEFORE UPDATE ON public.billing_trials
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_trial_updated_at();

CREATE TABLE IF NOT EXISTS public.entitlement_usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL CHECK (entitlement_key IN (
    'maxLocations', 'maxActiveUsers', 'maxActiveRegisters',
    'monthlyPosTransactions', 'monthlySalesOrders', 'monthlyEcommerceOrders',
    'monthlyPurchaseOrders', 'monthlyBills', 'dailyApiCalls', 'integrations'
  )),
  business_month date NOT NULL,
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- PostgreSQL NULLs do not conflict in a normal unique index. The pair of
-- partial indexes gives tenant-scoped counters (store_id NULL) and store-
-- scoped counters the same idempotent conflict target without a sentinel id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_usage_counter_store
  ON public.entitlement_usage_counters (tenant_id, store_id, entitlement_key, business_month)
  WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_usage_counter_tenant
  ON public.entitlement_usage_counters (tenant_id, entitlement_key, business_month)
  WHERE store_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_entitlement_usage_counter_tenant_month
  ON public.entitlement_usage_counters (tenant_id, business_month, entitlement_key);

ALTER TABLE public.entitlement_usage_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlement_usage_counters_tenant_isolation ON public.entitlement_usage_counters;
CREATE POLICY entitlement_usage_counters_tenant_isolation
  ON public.entitlement_usage_counters
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON public.entitlement_usage_counters TO app_runtime;

CREATE TABLE IF NOT EXISTS public.entitlement_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL CHECK (entitlement_key IN (
    'maxLocations', 'maxActiveUsers', 'maxActiveRegisters',
    'monthlyPosTransactions', 'monthlySalesOrders', 'monthlyEcommerceOrders',
    'monthlyPurchaseOrders', 'monthlyBills', 'dailyApiCalls', 'integrations'
  )),
  business_month date NOT NULL,
  source_key text NOT NULL,
  units integer NOT NULL DEFAULT 1 CHECK (units > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_usage_event_store
  ON public.entitlement_usage_events (tenant_id, store_id, entitlement_key, business_month, source_key)
  WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_usage_event_tenant
  ON public.entitlement_usage_events (tenant_id, entitlement_key, business_month, source_key)
  WHERE store_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_entitlement_usage_events_tenant_month
  ON public.entitlement_usage_events (tenant_id, business_month, entitlement_key);

ALTER TABLE public.entitlement_usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlement_usage_events_tenant_isolation ON public.entitlement_usage_events;
CREATE POLICY entitlement_usage_events_tenant_isolation
  ON public.entitlement_usage_events
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entitlement_usage_events TO app_runtime;

CREATE OR REPLACE FUNCTION public.touch_entitlement_usage_counter_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_entitlement_usage_counter_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_entitlement_usage_counter_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.touch_entitlement_usage_counter_updated_at() FROM authenticated;

DROP TRIGGER IF EXISTS entitlement_usage_counters_touch_updated_at ON public.entitlement_usage_counters;
CREATE TRIGGER entitlement_usage_counters_touch_updated_at
  BEFORE UPDATE ON public.entitlement_usage_counters
  FOR EACH ROW EXECUTE FUNCTION public.touch_entitlement_usage_counter_updated_at();

-- Reconstruct usage for already-committed POS sales. Imported history,
-- refunds, and failed/non-completed records are deliberately excluded.
INSERT INTO public.entitlement_usage_events
  (tenant_id, store_id, entitlement_key, business_month, source_key, units)
SELECT
  s.tenant_id,
  s.store_id,
  'monthlyPosTransactions',
  date_trunc('month', s.created_at AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'UTC'))::date,
  s.id::text,
  1
FROM public.sales s
JOIN public.tenants t ON t.id = s.tenant_id
WHERE s.source = 'pos'
  AND s.import_batch_id IS NULL
  AND s.status = 'completed'
ON CONFLICT DO NOTHING;

INSERT INTO public.entitlement_usage_counters
  (tenant_id, store_id, entitlement_key, business_month, used_count)
SELECT
  tenant_id,
  store_id,
  entitlement_key,
  business_month,
  SUM(units)::integer
FROM public.entitlement_usage_events
GROUP BY tenant_id, store_id, entitlement_key, business_month
ON CONFLICT DO UPDATE SET
  used_count = EXCLUDED.used_count,
  updated_at = now();
