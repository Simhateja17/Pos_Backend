-- 0062 — tax belongs to the sellable variant, and is snapshotted on a sale line.
--
-- Rates are decimal fractions: 0.05 means 5%, 0.18 means 18%. The columns
-- remain nullable so existing catalog and historical rows can continue using
-- the store-level fallback until they are reviewed. New catalog creation
-- requires an explicit item rate through the API.

ALTER TABLE public.variants
  ADD COLUMN IF NOT EXISTS tax_rate numeric(6,4);

ALTER TABLE public.sale_line_items
  ADD COLUMN IF NOT EXISTS tax_rate numeric(6,4);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'variants_tax_rate_fraction_check'
  ) THEN
    ALTER TABLE public.variants
      ADD CONSTRAINT variants_tax_rate_fraction_check
      CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sale_line_items_tax_rate_fraction_check'
  ) THEN
    ALTER TABLE public.sale_line_items
      ADD CONSTRAINT sale_line_items_tax_rate_fraction_check
      CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 1));
  END IF;
END
$$;
