-- 0031 — unit-of-measure, manufacturer barcodes, and fractional quantities.
--
-- Driven by the shift to general retail with supermarket / grocery / bakery as
-- the leading segments. Three changes, all additive or widening — nothing is
-- dropped and no existing value changes meaning:
--
-- 1. variants.unit_of_measure — what one unit of this variant IS. Defaults to
--    'piece', which is exactly how every existing variant already behaves, so
--    current rows keep their meaning without a backfill.
--
-- 2. variants.barcode — a MANUFACTURER-assigned EAN/UPC, deliberately separate
--    from sku. sku stays owner-assigned/auto-generated and remains the value
--    encoded into printed CODE128 labels; barcode is externally assigned and is
--    what a scanned supermarket product matches against. Conflating the two
--    would make auto-generation guess which kind of identifier it was holding.
--
-- 3. Quantity columns integer -> numeric(12,3). A variant sold by kg must be
--    sellable as 2.5, and stock must hold 12.75. Three decimal places carries
--    grams (0.001 kg) and millilitres exactly. Widening integer -> numeric is
--    lossless: every existing whole-number row is unchanged.
--
-- The loose/pre-packed case (e.g. rice sold both ways) needs no special support:
-- it is two ordinary variants of one product — one unit 'kg' priced per-kg with
-- no barcode, one unit 'piece' priced per packet carrying the maker's EAN.

-- 1. Unit of measure -----------------------------------------------------------

ALTER TABLE public.variants
  ADD COLUMN IF NOT EXISTS unit_of_measure text NOT NULL DEFAULT 'piece'
    CHECK (unit_of_measure IN (
      'piece', 'kg', 'gram', 'litre', 'ml', 'metre', 'box', 'pack', 'set', 'pair'
    ));

COMMENT ON COLUMN public.variants.unit_of_measure IS
  'What one unit of this variant is. price is always per ONE of this unit.';

-- 2. Manufacturer barcode ------------------------------------------------------

ALTER TABLE public.variants
  ADD COLUMN IF NOT EXISTS barcode text;

COMMENT ON COLUMN public.variants.barcode IS
  'Manufacturer-assigned EAN/UPC, when the product carries one. Separate from sku, which stays owner-assigned and is what printed labels encode.';

-- Scanning must resolve to exactly one variant within a tenant. Partial index so
-- the (overwhelmingly common) barcode-less variant is unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_tenant_barcode
  ON public.variants (tenant_id, barcode)
  WHERE barcode IS NOT NULL;

-- 3. Fractional quantities -----------------------------------------------------
-- Order matters: variant_stock_levels and stock_movements are read by
-- apply_stock_movement(), which is replaced below to match the widened types.

ALTER TABLE public.stock_movements
  ALTER COLUMN quantity_delta TYPE numeric(12,3);

ALTER TABLE public.variant_stock_levels
  ALTER COLUMN quantity TYPE numeric(12,3);

ALTER TABLE public.sale_line_items
  ALTER COLUMN quantity TYPE numeric(12,3);

ALTER TABLE public.purchase_order_lines
  ALTER COLUMN quantity_ordered TYPE numeric(12,3),
  ALTER COLUMN quantity_received TYPE numeric(12,3);

ALTER TABLE public.purchase_order_receipt_lines
  ALTER COLUMN quantity_received TYPE numeric(12,3);

ALTER TABLE public.reorder_suggestions
  ALTER COLUMN suggested_quantity TYPE numeric(12,3);

-- Reorder threshold follows the same logic: a kg-based variant reorders at 5.5kg.
ALTER TABLE public.variants
  ALTER COLUMN reorder_threshold TYPE numeric(12,3);

-- The nightly rollup SUMs sale-line quantities, so it must hold fractions too —
-- it is the input the ML forecast and reorder heuristic read. Left as integer,
-- every fractional sale would round on its way into the demand signal.
ALTER TABLE public.daily_sales_rollup
  ALTER COLUMN units_sold TYPE numeric(12,3),
  ALTER COLUMN returns_units TYPE numeric(12,3);

-- 4. Re-declare apply_stock_movement() with numeric locals ---------------------
-- Body is byte-for-byte 0019's logic (post-upsert guard, RETURNING-based read,
-- D-17 sale carve-out, direction check). ONLY the declared type of resulting_qty
-- changes: left as integer it would silently truncate a fractional balance.
CREATE OR REPLACE FUNCTION public.apply_stock_movement() RETURNS trigger AS $$
declare
  resulting_qty numeric(12,3);
begin
  insert into public.variant_stock_levels (variant_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now()
  returning quantity into resulting_qty;

  -- Guard only stock-decreasing movements, and keep D-17's `sale` carve-out.
  if new.quantity_delta < 0 and new.movement_type <> 'sale' and resulting_qty < 0 then
    raise exception 'Stock movement would take variant % below zero (currently %, delta %)',
      new.variant_id, resulting_qty - new.quantity_delta, new.quantity_delta
      using errcode = '23514';
  end if;

  -- D-04: lock variant identity attributes the first time any movement references it.
  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  return new;
end;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5. Re-declare apply_purchase_receipt_line() with numeric locals --------------
-- Same reasoning as above and just as load-bearing: stock_before feeds the
-- moving-average cost calculation that the dashboard's Gross Margin tile reads.
-- Left as integer, receiving 2.5kg would weight the average against a truncated
-- prior balance and silently report a wrong cost basis. Body is otherwise
-- identical to 0021's.
CREATE OR REPLACE FUNCTION public.apply_purchase_receipt_line() RETURNS trigger AS $$
declare
  stock_before numeric(12,3);
  average_before numeric(10, 2);
  po_id uuid;
  total_ordered numeric(12,3);
  total_received numeric(12,3);
begin
  select coalesce(vsl.quantity, 0), v.moving_average_cost
    into stock_before, average_before
  from public.variants v
  left join public.variant_stock_levels vsl on vsl.variant_id = v.id
  where v.id = new.variant_id;

  if stock_before > 0 and average_before is not null then
    update public.variants
      set moving_average_cost = round(
        ((stock_before * average_before) + (new.quantity_received * new.unit_cost))
        / (stock_before + new.quantity_received), 2)
      where id = new.variant_id;
  else
    update public.variants set moving_average_cost = new.unit_cost where id = new.variant_id;
  end if;

  insert into public.stock_movements (tenant_id, variant_id, movement_type, quantity_delta, reference_id)
  values (new.tenant_id, new.variant_id, 'receive', new.quantity_received, new.receipt_id);

  update public.purchase_order_lines
    set quantity_received = quantity_received + new.quantity_received
    where id = new.purchase_order_line_id
    returning purchase_order_id into po_id;

  select sum(quantity_ordered), sum(quantity_received)
    into total_ordered, total_received
  from public.purchase_order_lines where purchase_order_id = po_id;

  update public.purchase_orders
    set status = case
      when total_received >= total_ordered then 'received'::public.purchase_order_status
      else 'partial'::public.purchase_order_status
    end
    where id = po_id and status <> 'cancelled';

  return new;
end;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
