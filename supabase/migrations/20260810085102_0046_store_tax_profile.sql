-- 0046 — the tax profile belongs to the shop, not the business.
--
-- 0011_tax_profile.sql already anticipated this: "so a second location/state".
-- This is that second location arriving.
--
-- WHY EVEN WHILE V1 IS SAME-STATE-ONLY: a receipt must record the rate that
-- applied AT THE SHOP THAT MADE THE SALE, resolved from that shop, not looked
-- up from a business-wide default at read time. Same-state means those values
-- are identical today — it does not mean the sale should be reading them from
-- the wrong place.
--
-- EXPAND/CONTRACT, DELIBERATELY. The tenants.tax_rate_* columns are NOT dropped
-- here. src/routes/sales.ts and src/routes/settings.ts still read them, and
-- 0043/0044 already taught us what happens when a schema change lands ahead of
-- the code that reads it. The tenant columns become dead once task 8 switches
-- those readers to the store; dropping them is that task's job, not this one's.
--
-- WHAT STAYS ON THE BUSINESS: tax_id, pan, gst_status. Those are registration
-- identity, not location. GST registration is state-wise, so a same-state chain
-- has exactly one — when multi-state arrives, GSTIN moves down to the shop and
-- inter-state transfers become taxable supplies. Both are explicit non-goals.

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS tax_rate_state    numeric(6,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate_county   numeric(6,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate_city     numeric(6,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate_district numeric(6,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rounding_basis text NOT NULL DEFAULT 'per_invoice',
  ADD COLUMN IF NOT EXISTS place_of_supply   text;

-- Backfill every existing shop from its business, so the switch-over in task 8
-- is a no-op change in behaviour rather than a silent reset to zero rates.
UPDATE public.stores s
SET tax_rate_state     = t.tax_rate_state,
    tax_rate_county    = t.tax_rate_county,
    tax_rate_city      = t.tax_rate_city,
    tax_rate_district  = t.tax_rate_district,
    tax_rounding_basis = t.tax_rounding_basis,
    place_of_supply    = t.place_of_supply
FROM public.tenants t
WHERE t.id = s.tenant_id;

-- Mirror the LIVE constraint on tenants exactly. It permits only 'per_invoice'
-- — per-line rounding was never implemented, and inventing a second allowed
-- value here would let a shop be configured into a mode the money code
-- (lib/money.ts computeCheckout) does not handle.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_tax_rounding_basis_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_tax_rounding_basis_check
      CHECK (tax_rounding_basis = 'per_invoice');
  END IF;
END
$$;
