-- 0059 — the combined jurisdiction rate must also be a decimal fraction.
--
-- 0058 protects each stored field. This protects the value consumed by
-- checkout after the four jurisdictions are summed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tax_rate_combined_fraction_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_tax_rate_combined_fraction_check
      CHECK (tax_rate_state + tax_rate_county + tax_rate_city + tax_rate_district <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tax_rate_combined_fraction_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_tax_rate_combined_fraction_check
      CHECK (tax_rate_state + tax_rate_county + tax_rate_city + tax_rate_district <= 1);
  END IF;
END
$$;
