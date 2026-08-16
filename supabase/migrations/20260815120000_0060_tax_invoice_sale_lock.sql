-- 0060 — lock an immutable sale for tax-invoice idempotency.
--
-- app_runtime intentionally has SELECT/INSERT, but not UPDATE, on sales.
-- SELECT ... FOR UPDATE therefore cannot be issued directly by the runtime
-- role, even though the tax-document workflow needs a serialization point.
-- Keep the append-only sales grant and expose only this tenant-checked lock
-- boundary instead.

BEGIN;

CREATE OR REPLACE FUNCTION public.lock_tax_invoice_sale(
  p_tenant_id uuid,
  p_sale_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  locked_sale_id uuid;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Tax invoice sale lock tenant mismatch';
  END IF;

  SELECT id
  INTO locked_sale_id
  FROM public.sales
  WHERE id = p_sale_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  RETURN locked_sale_id;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_tax_invoice_sale(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_tax_invoice_sale(uuid, uuid)
  TO app_runtime;

COMMIT;
