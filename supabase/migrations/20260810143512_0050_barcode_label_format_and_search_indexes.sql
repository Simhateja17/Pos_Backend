-- 0050 — barcode label symbology as a real store setting, plus index support
-- for the catalog search path that a barcode scan lands on.
--
-- Two unrelated-looking changes that are both about the same feature: barcode
-- generation (what we print) and barcode scanning (what we look up).
--
-- 1. tenants.barcode_label_format
--
--    0031 hardcoded printed labels to CODE128 and the deleted onboarding
--    wizard collected a `barcodeFormat` answer that no code ever read. This
--    makes the choice real and puts it where it is actually editable — store
--    settings — instead of a one-shot wizard step that no longer exists.
--
--    The wizard's 'internal' option is deliberately NOT carried over: it meant
--    "our own codes", which is exactly what CODE128 already encodes. Four
--    values, each a symbology the label renderer can actually produce.
--
--    Default 'code128' is precisely how every existing tenant's labels already
--    print, so no backfill changes any current behaviour.
--
-- 2. Trigram indexes on products.name and variants.sku
--
--    GET /products?search= is the scan target. Exact barcode and exact SKU
--    lookups are already index-backed by 0031's idx_variants_tenant_barcode
--    and 0006's (tenant_id, sku) unique, but the by-name / partial-SKU
--    fallback is an ILIKE '%…%', which no btree index can serve. At the
--    10,000-SKU tier the roadmap targets, that is a sequential scan on the
--    one interaction that has to feel instant.
--
--    pg_trgm GIN indexes serve leading-wildcard ILIKE directly.

begin;

-- 1. Label symbology -----------------------------------------------------------

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS barcode_label_format text NOT NULL DEFAULT 'code128'
    CHECK (barcode_label_format IN ('code128', 'ean13', 'upca', 'qr'));

COMMENT ON COLUMN public.tenants.barcode_label_format IS
  'Symbology used when printing variant labels. code128 encodes our own SKU; ean13/upca encode the manufacturer barcode and require one to be present; qr encodes the SKU as a 2D code.';

-- 2. Search indexes ------------------------------------------------------------
-- Supabase convention (see uuid-ossp, pgcrypto): extensions live in the
-- `extensions` schema, not public.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Not CONCURRENTLY: index builds cannot run inside a transaction block, and at
-- pilot catalog sizes the brief write lock is immaterial. Revisit if a tenant
-- ever reaches a size where this build is not near-instant.
CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON public.products USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_variants_sku_trgm
  ON public.variants USING gin (sku extensions.gin_trgm_ops);

commit;
