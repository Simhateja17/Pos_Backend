-- 0030 — business identity captured at signup instead of onboarding steps 1-2.
--
-- Onboarding steps 1 ("Business Identity") and 2 ("GST & Legal Compliance")
-- re-asked details signup had already collected, then wrote them to the
-- onboarding_data JSON blob rather than back to these columns — so a tenant
-- could hold two different names for the same business and only one was real.
-- Signup is now the single capture point, so the fields it gained need real
-- columns here.
--
-- GST fields are nullable by design: GST registration is not mandatory in India
-- below the ₹40L (goods) / ₹20L (services) turnover threshold, so a legitimate
-- small retailer genuinely has no GSTIN, PAN-on-file, or place of supply yet.
-- gstin continues to live in the existing tax_id column.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS trade_name text,
  ADD COLUMN IF NOT EXISTS gst_status text
    CHECK (gst_status IS NULL OR gst_status IN ('regular', 'composition', 'unregistered')),
  ADD COLUMN IF NOT EXISTS pan text,
  ADD COLUMN IF NOT EXISTS place_of_supply text;

COMMENT ON COLUMN public.tenants.trade_name IS
  'Optional brand/trading name. business_name holds the legal registered name.';
COMMENT ON COLUMN public.tenants.gst_status IS
  'NULL until the owner tells us. Not required to operate a till below the GST registration threshold.';
