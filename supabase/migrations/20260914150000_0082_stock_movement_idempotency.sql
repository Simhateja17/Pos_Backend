-- 0082 — stable retry authority for direct stock movements only.

ALTER TABLE public.stock_movements
  ADD COLUMN client_movement_id uuid,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT stock_movements_client_request_pair_check CHECK (
    (client_movement_id IS NULL AND request_hash IS NULL)
    OR
    (client_movement_id IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX uq_stock_movements_client_operation
  ON public.stock_movements (tenant_id, store_id, client_movement_id);
