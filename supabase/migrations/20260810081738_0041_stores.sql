-- 0041 — stores: a physical shop belonging to one business.
--
-- Until now `tenant` meant both "the business" and "the store", 1:1 (D-01 in
-- 0001_init_schema.sql). A business with two shops had no way to say which
-- shelf stock sat on, which till took the cash, or which outlet a sale
-- happened at.
--
-- From here: business (tenant) -> store -> terminal (counter).
--
-- The tenant REMAINS the security boundary. Every existing RLS policy keeps its
-- current meaning, unchanged. store_id is a new dimension INSIDE that boundary,
-- not a re-parenting of it — which is why 0002's policies and the 30 tables
-- built on them are untouched by this phase.
--
-- Same-state only for V1: multi-state operation needs per-store GST
-- registration and makes an inter-store transfer a taxable supply. The tax
-- profile still moves onto the store (0045) so that later work is additive,
-- but this migration does not attempt multi-state.

CREATE TABLE IF NOT EXISTS public.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Address is per-shop from the start. The business address on `tenants` is
  -- the registered/billing address and is NOT the same thing as where a given
  -- outlet trades from — receipts must name the shop that made the sale.
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text NOT NULL DEFAULT 'IN',
  -- Deactivated rather than deleted: a store is referenced by historical sales,
  -- shifts and Z reports, and those must keep naming the shop they happened at.
  -- Same reasoning as terminals (0034).
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stores_tenant_id ON public.stores(tenant_id);

-- Case-insensitive uniqueness per business, matching terminals (0034) and
-- categories (0032): stops "Andheri" and "andheri" coexisting as two shops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_tenant_name_lower
  ON public.stores (tenant_id, lower(name));

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_stores ON public.stores
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO app_runtime;

-- Backfill ------------------------------------------------------------------
--
-- EVERY existing tenant gets exactly one store. This is the invariant the rest
-- of the phase depends on: tasks 2-4 add NOT NULL store_id columns backfilled
-- from here, so a tenant without a store would make those migrations fail.
--
-- Named from the tenant's own business_name so the owner recognises it
-- immediately rather than finding a shop called "Main Store" they never made.
-- Nothing looks different to a single-shop owner until they add a second.
INSERT INTO public.stores (tenant_id, name, address_line1, address_line2, city, state, postal_code, country)
SELECT
  t.id,
  t.business_name,
  t.address_line1,
  t.address_line2,
  t.city,
  t.state,
  t.postal_code,
  t.country
FROM public.tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM public.stores s WHERE s.tenant_id = t.id
);

-- Guard: fail loudly here rather than part-way through 0043's stock split if
-- the backfill missed anyone. A tenant with no store is not a recoverable
-- state once NOT NULL store_id columns exist.
DO $$
DECLARE
  storeless_count integer;
BEGIN
  SELECT count(*) INTO storeless_count
  FROM public.tenants t
  WHERE NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.tenant_id = t.id);

  IF storeless_count > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete: % tenant(s) have no store. Later migrations add NOT NULL store_id and will fail.', storeless_count;
  END IF;
END
$$;
