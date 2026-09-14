-- 0086 — bind each new POS sale idempotency key to its immutable request.
--
-- The tenant-wide unique client_sale_id already guarantees at most one sale.
-- This hash closes the other half of the contract: reusing that key with a
-- changed cart, shift, customer, discount or tender must be a conflict rather
-- than silently returning an unrelated receipt. Legacy/import-created sales
-- remain nullable so historical data and deterministic imports keep working.

ALTER TABLE public.sales
  ADD COLUMN request_hash text,
  ADD CONSTRAINT sales_request_hash_format_check CHECK (
    request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
  );

CREATE FUNCTION public.lock_sale_client_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.client_sale_id IS DISTINCT FROM NEW.client_sale_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash THEN
    RAISE EXCEPTION 'sale client authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_sale_client_authority() FROM PUBLIC;

CREATE TRIGGER trg_lock_sale_client_authority
BEFORE UPDATE OF tenant_id, client_sale_id, request_hash
ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.lock_sale_client_authority();
