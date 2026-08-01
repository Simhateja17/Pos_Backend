-- 0032 — categories become real rows the store owns, not free text on a product.
--
-- products.category was a plain text column, so "Dairy", "dairy" and "Diary"
-- were three different categories and every report split accordingly. Nothing
-- could rename a category, and a bulk import minted a new one per spelling.
--
-- This also gives the business-type question at signup something real to do.
-- The vertical picker was deleted in 0030's era precisely because it drove
-- nothing; it comes back here only as the seed for a starter category list,
-- which is an actual, visible day-one effect.

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Owner-controlled display order; ties break by name.
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_categories_tenant_id ON public.categories(tenant_id);

-- Case-insensitive uniqueness is the whole point: it is what stops "Dairy" and
-- "dairy" coexisting. Enforced in the DB so an import cannot bypass it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_tenant_name_lower
  ON public.categories (tenant_id, lower(name));

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_categories ON public.categories
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories TO app_runtime;

-- Link products to the new table ----------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_category_id ON public.products(category_id);

-- Backfill: every distinct non-empty category text already in use becomes a real
-- row for its tenant, then products point at it. Case-insensitive grouping means
-- pre-existing "Dairy"/"dairy" collapse into one category, which is the fix.
INSERT INTO public.categories (tenant_id, name)
SELECT DISTINCT ON (tenant_id, lower(trim(category)))
       tenant_id, trim(category)
FROM public.products
WHERE category IS NOT NULL AND trim(category) <> ''
ORDER BY tenant_id, lower(trim(category)), created_at
ON CONFLICT DO NOTHING;

UPDATE public.products p
SET category_id = c.id
FROM public.categories c
WHERE c.tenant_id = p.tenant_id
  AND p.category IS NOT NULL
  AND lower(trim(p.category)) = lower(c.name);

-- The old text column is dropped rather than kept in sync: two sources of truth
-- for the same fact is how the "Dairy"/"dairy" split happened in the first place.
ALTER TABLE public.products DROP COLUMN IF EXISTS category;

-- Business type, solely to seed the starter category list ----------------------

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS business_type text;

COMMENT ON COLUMN public.tenants.business_type IS
  'What kind of shop this is. Used to seed a starter category list at signup and nothing else — it gates no feature and changes no tax behaviour.';
