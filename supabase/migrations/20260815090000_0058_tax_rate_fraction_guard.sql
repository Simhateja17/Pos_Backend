-- 0058 — tax rates are decimal fractions everywhere.
--
-- The money layer expects 0.18 for 18%. Without a database invariant, a seed
-- or direct SQL write of 18 is valid numeric data but turns every taxable sale
-- into an 1800% tax calculation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tax_rate_state_fraction_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_tax_rate_state_fraction_check
      CHECK (tax_rate_state >= 0 AND tax_rate_state <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tax_rate_county_fraction_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_tax_rate_county_fraction_check
      CHECK (tax_rate_county >= 0 AND tax_rate_county <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tax_rate_city_fraction_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_tax_rate_city_fraction_check
      CHECK (tax_rate_city >= 0 AND tax_rate_city <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tax_rate_district_fraction_check'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_tax_rate_district_fraction_check
      CHECK (tax_rate_district >= 0 AND tax_rate_district <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tax_rate_state_fraction_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_tax_rate_state_fraction_check
      CHECK (tax_rate_state >= 0 AND tax_rate_state <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tax_rate_county_fraction_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_tax_rate_county_fraction_check
      CHECK (tax_rate_county >= 0 AND tax_rate_county <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tax_rate_city_fraction_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_tax_rate_city_fraction_check
      CHECK (tax_rate_city >= 0 AND tax_rate_city <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tax_rate_district_fraction_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_tax_rate_district_fraction_check
      CHECK (tax_rate_district >= 0 AND tax_rate_district <= 1);
  END IF;
END
$$;
