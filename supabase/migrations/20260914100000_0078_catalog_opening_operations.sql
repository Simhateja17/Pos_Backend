-- 0078 — immutable idempotency authority for atomic product + opening stock creation.

CREATE TABLE public.catalog_opening_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.staff_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_catalog_opening_operation UNIQUE (tenant_id, store_id, client_operation_id),
  CONSTRAINT uq_catalog_opening_product UNIQUE (product_id)
);

CREATE INDEX idx_catalog_opening_operations_tenant
  ON public.catalog_opening_operations (tenant_id, created_at DESC);

ALTER TABLE public.catalog_opening_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_catalog_opening_operations
  ON public.catalog_opening_operations
  USING (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);

REVOKE ALL ON public.catalog_opening_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.catalog_opening_operations TO app_runtime;
