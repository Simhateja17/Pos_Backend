-- 0083 — address existing Supabase advisor findings on the stock ledger.

CREATE INDEX idx_stock_movements_created_by
  ON public.stock_movements (created_by);

DROP POLICY tenant_isolation_stock_movements ON public.stock_movements;

CREATE POLICY tenant_isolation_stock_movements
  ON public.stock_movements
  USING (
    tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
  )
  WITH CHECK (
    tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
  );
