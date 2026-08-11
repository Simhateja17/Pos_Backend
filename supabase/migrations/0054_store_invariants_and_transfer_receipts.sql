-- 0054 — database-enforced shop invariants and idempotent transfer receipt.

ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS client_receive_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_transfers_client_receive_id
  ON public.stock_transfers (tenant_id, client_receive_id)
  WHERE client_receive_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_variant_id
  ON public.stock_transfer_lines (variant_id);
CREATE INDEX IF NOT EXISTS idx_daily_sales_rollup_store_id
  ON public.daily_sales_rollup (store_id);
CREATE INDEX IF NOT EXISTS idx_reorder_suggestions_store_id
  ON public.reorder_suggestions (store_id);

-- The route-level count makes a good error message, but only a database lock
-- makes the plan allowance safe when two browser tabs create/reactivate shops
-- concurrently. The same per-tenant lock also serialises "last active shop"
-- deactivation checks.
CREATE OR REPLACE FUNCTION public.enforce_store_business_rules() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  business_state text;
  active_count integer;
  store_limit integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  SELECT state INTO business_state
  FROM public.tenants
  WHERE id = NEW.tenant_id;

  IF business_state IS NULL THEN
    RAISE EXCEPTION 'Business state is required before a store can be opened'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS NULL OR btrim(NEW.state) = '' THEN
    NEW.state := business_state;
  ELSIF lower(btrim(NEW.state)) <> lower(btrim(business_state)) THEN
    RAISE EXCEPTION 'All stores must be in the business registration state (%)', business_state
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer INTO active_count
  FROM public.stores
  WHERE tenant_id = NEW.tenant_id AND is_active;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_active AND NOT NEW.is_active AND active_count <= 1 THEN
      RAISE EXCEPTION 'A business must have at least one active store'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Keep INSERT and UPDATE branches separate so an INSERT never evaluates the
  -- undefined OLD record.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_active AND NOT OLD.is_active THEN
      SELECT coalesce(included_store_count + additional_store_count, 1)
        INTO store_limit
      FROM public.billing_subscriptions
      WHERE tenant_id = NEW.tenant_id
        AND status::text IN ('created', 'authenticated', 'active', 'pending', 'halted')
      ORDER BY updated_at DESC
      LIMIT 1;

      store_limit := coalesce(store_limit, 1);
      IF active_count >= store_limit THEN
        RAISE EXCEPTION 'Store allowance reached (% active of % allowed)', active_count, store_limit
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.is_active THEN
    SELECT coalesce(included_store_count + additional_store_count, 1)
      INTO store_limit
    FROM public.billing_subscriptions
    WHERE tenant_id = NEW.tenant_id
      AND status::text IN ('created', 'authenticated', 'active', 'pending', 'halted')
    ORDER BY updated_at DESC
    LIMIT 1;

    store_limit := coalesce(store_limit, 1);
    IF active_count >= store_limit THEN
      RAISE EXCEPTION 'Store allowance reached (% active of % allowed)', active_count, store_limit
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_store_business_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_store_business_rules() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_store_business_rules() FROM authenticated;

DROP TRIGGER IF EXISTS trg_enforce_store_business_rules ON public.stores;
CREATE TRIGGER trg_enforce_store_business_rules
  BEFORE INSERT OR UPDATE OF state, is_active ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.enforce_store_business_rules();
