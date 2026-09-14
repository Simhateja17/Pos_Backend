-- 0079 — address Supabase performance-advisor findings for catalog opening operations.

CREATE INDEX idx_catalog_opening_operations_store
  ON public.catalog_opening_operations (store_id);

CREATE INDEX idx_catalog_opening_operations_created_by
  ON public.catalog_opening_operations (created_by);

DROP POLICY tenant_isolation_catalog_opening_operations
  ON public.catalog_opening_operations;

CREATE POLICY tenant_isolation_catalog_opening_operations
  ON public.catalog_opening_operations
  USING (
    tenant_id = (SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  )
  WITH CHECK (
    tenant_id = (SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  );
