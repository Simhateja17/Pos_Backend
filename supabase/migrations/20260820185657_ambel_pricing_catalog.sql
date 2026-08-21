-- 0061 — Ambel POS pricing catalogue and Pro add-on counters.
--
-- Existing subscription entitlement snapshots are historical purchase records.
-- This migration only adds columns/constraints and teaches the snapshot trigger
-- how to project new subscriptions; it does not reprice or rewrite populated
-- snapshots for existing tenants.

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS additional_register_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS additional_user_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_subscriptions_additional_register_count_non_negative'
  ) THEN
    ALTER TABLE public.billing_subscriptions
      ADD CONSTRAINT billing_subscriptions_additional_register_count_non_negative
      CHECK (additional_register_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'billing_subscriptions_additional_user_count_non_negative'
  ) THEN
    ALTER TABLE public.billing_subscriptions
      ADD CONSTRAINT billing_subscriptions_additional_user_count_non_negative
      CHECK (additional_user_count >= 0);
  END IF;
END;
$$;

-- `US` is retained for rows written by the earlier US-only catalogue. New
-- international checkout uses the canonical INTL value.
DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conrelid::regclass AS relation_name, conname
    FROM pg_constraint
    WHERE conrelid IN (
      'public.billing_subscription_attempts'::regclass,
      'public.billing_subscriptions'::regclass,
      'public.billing_trials'::regclass
    )
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%region%'
      AND pg_get_constraintdef(oid) ILIKE '%US%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.relation_name, constraint_row.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.billing_subscription_attempts
  ADD CONSTRAINT billing_subscription_attempts_region_check
  CHECK (region IN ('IN', 'INTL', 'US'));

ALTER TABLE public.billing_subscriptions
  ADD CONSTRAINT billing_subscriptions_region_check
  CHECK (region IN ('IN', 'INTL', 'US'));

ALTER TABLE public.billing_trials
  ADD CONSTRAINT billing_trials_region_check
  CHECK (region IN ('IN', 'INTL', 'US'));

CREATE OR REPLACE FUNCTION public.set_billing_entitlement_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'billing_subscriptions' THEN
    -- Preserve the old colliding US Professional key for legacy rows.
    IF NEW.region = 'US' AND NEW.plan_key = 'professional' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 5);
    END IF;

    -- The application also writes this allowance. The trigger is a database
    -- boundary for direct/runtime inserts and keeps the legacy store trigger
    -- from under-counting a newly created subscription.
    IF NEW.region = 'IN' AND NEW.plan_key = 'starter' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 2);
    ELSIF NEW.region = 'IN' AND NEW.plan_key = 'growth' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 5);
    ELSIF NEW.region = 'IN' AND NEW.plan_key = 'pro' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 6);
    ELSIF NEW.region = 'INTL' AND NEW.plan_key = 'starter' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 2);
    ELSIF NEW.region = 'INTL' AND NEW.plan_key = 'growth' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 5);
    ELSIF NEW.region = 'INTL' AND NEW.plan_key = 'pro' THEN
      NEW.included_store_count := greatest(NEW.included_store_count, 15);
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
      -- Historical India catalogue keys remain stable for rows created by the
      -- previous application version.
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'free' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'free', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 1, 'maxActiveUsers', 1, 'maxActiveRegisters', 1,
          'monthlyPosTransactions', 50, 'monthlySalesOrders', 50,
          'monthlyEcommerceOrders', 50, 'monthlyPurchaseOrders', 20,
          'monthlyBills', 20, 'dailyApiCalls', 1500, 'integrations', 0
        )
      )
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
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'starter' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'starter', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 2, 'maxActiveUsers', 5, 'maxActiveRegisters', 3,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'growth' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'growth', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 5, 'maxActiveUsers', 15, 'maxActiveRegisters', 8,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'IN' AND NEW.plan_key = 'pro' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'pro', 'region', 'IN', 'limits', jsonb_build_object(
          'maxLocations', 6, 'maxActiveUsers', 10, 'maxActiveRegisters', 6,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'INTL' AND NEW.plan_key = 'starter' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'starter', 'region', 'INTL', 'limits', jsonb_build_object(
          'maxLocations', 2, 'maxActiveUsers', 5, 'maxActiveRegisters', 3,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'INTL' AND NEW.plan_key = 'growth' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'growth', 'region', 'INTL', 'limits', jsonb_build_object(
          'maxLocations', 5, 'maxActiveUsers', 15, 'maxActiveRegisters', 8,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      WHEN NEW.region = 'INTL' AND NEW.plan_key = 'pro' THEN jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'pro', 'region', 'INTL', 'limits', jsonb_build_object(
          'maxLocations', 15, 'maxActiveUsers', 25, 'maxActiveRegisters', 15,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
        )
      )
      -- Legacy US rows are not reinterpreted as INTL rows.
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
      ELSE jsonb_build_object(
        'version', 'india-mvp-04-v1', 'planKey', 'starter', 'region', NEW.region, 'limits', jsonb_build_object(
          'maxLocations', 2, 'maxActiveUsers', 5, 'maxActiveRegisters', 3,
          'monthlyPosTransactions', 'unlimited', 'monthlySalesOrders', 'unlimited',
          'monthlyEcommerceOrders', 'unlimited', 'monthlyPurchaseOrders', 'unlimited',
          'monthlyBills', 'unlimited', 'dailyApiCalls', 'unlimited', 'integrations', 0
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
