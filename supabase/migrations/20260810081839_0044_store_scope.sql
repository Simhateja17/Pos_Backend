-- 0044 — every operational record names the store it happened at.
--
-- `customers` deliberately does NOT get a store_id. Customers are business-wide:
-- someone who buys at Andheri and returns at Bandra is one person with one
-- history. WHICH shop a customer transacted at is recorded on the sale, which
-- is where that fact belongs.
--
-- Two of these tables change GRAIN, not just gain a column — their unique keys
-- are widened below. Missing that would silently merge two shops' numbers into
-- one row.

-- Simple scoping: add, backfill from the tenant's 0041 store, enforce ---------

ALTER TABLE public.sales                   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.shifts                  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.terminals               ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.purchase_orders         ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.purchase_order_receipts ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales','shifts','terminals','purchase_orders','purchase_order_receipts']
  LOOP
    EXECUTE format(
      'UPDATE public.%I x SET store_id = s.id FROM public.stores s
         WHERE s.tenant_id = x.tenant_id AND x.store_id IS NULL', t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN store_id SET NOT NULL', t);
    -- %I on a concatenated name, not embedded in a literal: format('idx_%I_store_id', t)
    -- would quote the middle and emit the invalid idx_"sales"_store_id.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(store_id)',
                   'idx_' || t || '_store_id', t);
  END LOOP;
END
$$;

-- daily_sales_rollup — grain change ------------------------------------------
--
-- Was (tenant, variant, date). Becomes (tenant, store, variant, date). Without
-- the widened key, Andheri selling 3 and Bandra selling 4 would collide into a
-- single row of 7 and the per-shop forecast would have nothing to read.

ALTER TABLE public.daily_sales_rollup
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

UPDATE public.daily_sales_rollup r
SET store_id = s.id
FROM public.stores s
WHERE s.tenant_id = r.tenant_id AND r.store_id IS NULL;

ALTER TABLE public.daily_sales_rollup ALTER COLUMN store_id SET NOT NULL;

ALTER TABLE public.daily_sales_rollup DROP CONSTRAINT daily_sales_rollup_pkey;
ALTER TABLE public.daily_sales_rollup
  ADD CONSTRAINT daily_sales_rollup_pkey PRIMARY KEY (tenant_id, store_id, variant_id, date);

-- reorder_suggestions — grain change -----------------------------------------
--
-- 0026's one-suggestion-per-variant-per-day guard must become one per variant
-- per STORE per day, or the nightly job's second shop would upsert over the
-- first shop's suggestion and the owner would see one shop's number attributed
-- to all of them.

ALTER TABLE public.reorder_suggestions
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

UPDATE public.reorder_suggestions rs
SET store_id = s.id
FROM public.stores s
WHERE s.tenant_id = rs.tenant_id AND rs.store_id IS NULL;

ALTER TABLE public.reorder_suggestions ALTER COLUMN store_id SET NOT NULL;

DROP INDEX IF EXISTS public.idx_reorder_suggestions_tenant_variant_day;
CREATE UNIQUE INDEX idx_reorder_suggestions_tenant_store_variant_day
  ON public.reorder_suggestions (
    tenant_id, store_id, variant_id, ((generated_at AT TIME ZONE 'UTC')::date)
  );

-- Rollup triggers -----------------------------------------------------------
--
-- Both write into the now-wider key and must supply store_id. The sale side
-- takes it from the sale; the return side takes it from the movement, which
-- gained store_id in 0043.
--
-- NOTE: business_date is still resolved from tenants.timezone. That is correct
-- while V1 is same-state-only. If stores ever span timezones, timezone moves to
-- the store alongside the tax profile — same reasoning, same shape.

CREATE OR REPLACE FUNCTION public.apply_sale_line_to_rollup() RETURNS trigger AS $$
declare
  business_date date;
  sale_store_id uuid;
begin
  select (s.created_at at time zone t.timezone)::date, s.store_id
    into business_date, sale_store_id
  from public.sales s
  join public.tenants t on t.id = s.tenant_id
  where s.id = new.sale_id;

  insert into public.daily_sales_rollup (tenant_id, store_id, variant_id, date, units_sold, revenue)
  values (new.tenant_id, sale_store_id, new.variant_id, business_date, new.quantity, new.line_total)
  on conflict (tenant_id, store_id, variant_id, date) do update
    set units_sold = daily_sales_rollup.units_sold + excluded.units_sold,
        revenue = daily_sales_rollup.revenue + excluded.revenue;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

CREATE OR REPLACE FUNCTION public.apply_return_to_rollup() RETURNS trigger AS $$
declare
  business_date date;
begin
  if new.movement_type <> 'return' then
    return new;
  end if;

  select (new.created_at at time zone t.timezone)::date
    into business_date
  from public.tenants t where t.id = new.tenant_id;

  -- The return is attributed to the shop that ACCEPTED it, which may not be the
  -- shop that made the sale. That is intentional and matches where the stock
  -- physically lands and where the refund leaves the till. Per-shop reports
  -- must surface these separately so the numbers are not confusing.
  insert into public.daily_sales_rollup (tenant_id, store_id, variant_id, date, returns_units)
  values (new.tenant_id, new.store_id, new.variant_id, business_date, new.quantity_delta)
  on conflict (tenant_id, store_id, variant_id, date) do update
    set returns_units = daily_sales_rollup.returns_units + excluded.returns_units;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
