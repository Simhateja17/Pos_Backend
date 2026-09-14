-- 0080 — stable client authority for retry-safe purchase-order creation.

ALTER TABLE public.purchase_orders
  ADD COLUMN client_purchase_order_id uuid,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT purchase_orders_client_request_pair_check CHECK (
    (client_purchase_order_id IS NULL AND request_hash IS NULL)
    OR
    (client_purchase_order_id IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX uq_purchase_orders_client_operation
  ON public.purchase_orders (tenant_id, store_id, client_purchase_order_id);

CREATE FUNCTION public.lock_purchase_order_client_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.client_purchase_order_id IS DISTINCT FROM NEW.client_purchase_order_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash THEN
    RAISE EXCEPTION 'purchase order client authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_purchase_order_client_authority() FROM PUBLIC;

CREATE TRIGGER trg_lock_purchase_order_client_authority
BEFORE UPDATE OF client_purchase_order_id, request_hash
ON public.purchase_orders
FOR EACH ROW
EXECUTE FUNCTION public.lock_purchase_order_client_authority();
