-- Phase 6 forecast fixture — 91 days of demand history.
--
-- WHY THIS EXISTS
--
-- `daily_sales_rollup` is Phase 6's only input and it is empty: Phases 5 and 7
-- both removed their fixtures when they finished. Without history there is
-- nothing to forecast, no maturity gate to exercise, and no way to check that a
-- suggestion can be recomputed by hand from its stored `reason`.
--
-- HOW IT BUILDS THE ROLLUP
--
-- Through the real ledger. This writes `sales` + `sale_line_items` and lets the
-- AFTER INSERT trigger from migration 0022 derive `daily_sales_rollup` itself.
-- Inserting into the rollup directly would be faster and would be a lie: it
-- would not prove the trigger buckets business days correctly, and it would
-- leave stock levels untouched, so no reorder suggestion would ever fire.
--
-- Sale stock movements ARE written here, unlike Phase 7's import — these are
-- meant to look like trading history, so the stock they consumed should be
-- gone. That is also what lets SEED-STOCKOUT-03 genuinely reach zero.
--
-- TIMEZONE
--
-- The tenant is Asia/Kolkata. Timestamps are built as local 14:00 and
-- converted, so every sale lands unambiguously inside one business day. Phase 7
-- already verified the midnight boundary separately; this fixture deliberately
-- stays away from it, so a forecasting bug can never be mistaken for a
-- bucketing bug.
--
-- WHAT EACH VARIANT IS FOR
--
--   SEED-FAST-01      91d, strong weekly seasonality (weekends ~2x weekdays).
--                     The variant a forecast should beat the heuristic on.
--                     Also carries the only open purchase order, so `on_order`
--                     is non-zero somewhere and cannot be quietly dropped.
--   SEED-STEADY-02    91d, flat. A seasonal model should NOT invent a weekly
--                     pattern here — this is the false-positive check.
--   SEED-STOCKOUT-03  91d with a 12-day hole where stock sat at exactly zero.
--                     Opening stock is tuned so the balance lands on 0 rather
--                     than oversold — a negative balance would still read as
--                     "out of stock" but would be an arithmetic artifact
--                     pretending to be a signal. Those zeros are censored
--                     demand, not absence of demand. Detectable from
--                     `stock_movements`: the running balance reaches 0 and no
--                     receipt lands until the gap ends. This
--                     is the trap named in the plan's Risk section and the one
--                     variant here that will actively mislead a model that
--                     treats a zero as truth.
--   SEED-BOUNDARY-04  62d of history — just over a 60-day gate, so an
--                     off-by-one changes its classification.
--   SEED-SPARSE-05    91d but ~1 unit every fifth day. Long history, trivial
--                     volume: must fail a volume gate despite passing a
--                     days-of-history gate.
--   SEED-NEW-06       9d. Fails the Phase 5 heuristic's MIN_HISTORY_DAYS (14)
--                     and any forecast gate. Must produce neither.
--
-- Every row is prefixed SEED-. Remove with phase-06-forecast-fixture-down.sql.

begin;

-- Helper: one sale, one line, one payment, one stock movement. Created for the
-- duration of this script and dropped at the end — it is fixture scaffolding,
-- not schema.
create function public.seed_record_sale(
  p_tenant  uuid,
  p_variant uuid,
  p_qty     integer,
  p_price   numeric,
  p_at      timestamptz,
  p_staff   uuid
) returns void as $fn$
declare
  v_sale  uuid;
  v_total numeric(12,2) := (p_qty * p_price)::numeric(12,2);
begin
  insert into public.sales
    (tenant_id, client_sale_id, subtotal, discount_amount, tax_amount, total_amount,
     status, source, created_by, created_at)
  values
    (p_tenant, gen_random_uuid(), v_total, 0, 0, v_total,
     'completed', 'pos', p_staff, p_at)
  returning id into v_sale;

  insert into public.sale_line_items
    (tenant_id, sale_id, variant_id, quantity, unit_price, discount_amount,
     is_taxable, line_total, created_at)
  values
    (p_tenant, v_sale, p_variant, p_qty, p_price, 0, true, v_total, p_at);

  insert into public.payments
    (tenant_id, sale_id, method, direction, amount, created_by, created_at)
  values
    (p_tenant, v_sale, 'cash', 'payment', v_total, p_staff, p_at);

  insert into public.stock_movements
    (tenant_id, variant_id, movement_type, quantity_delta, reference_id, created_by, created_at)
  values
    (p_tenant, p_variant, 'sale', -p_qty, v_sale, p_staff, p_at);
end;
$fn$ language plpgsql;

do $$
declare
  v_tenant   uuid := '2df6a042-6af2-41b0-a81c-d453b7607465';  -- Couture, IN, Asia/Kolkata
  v_supplier uuid;
  v_staff    uuid;
  v_product  uuid;
  v_po       uuid;

  v_fast     uuid;
  v_steady   uuid;
  v_stockout uuid;
  v_boundary uuid;
  v_sparse   uuid;
  v_new      uuid;

  d       integer;
  qty     integer;
  dow     integer;
  sale_at timestamptz;
begin
  ---------------------------------------------------------------------------
  -- Supporting records
  ---------------------------------------------------------------------------
  insert into public.suppliers (tenant_id, name, contact_name, email, lead_time_days, is_active)
    values (v_tenant, 'SEED Mumbai Textiles', 'Priya Nair', 'seed-supplier@example.com', 7, true)
    returning id into v_supplier;

  insert into public.staff_members (tenant_id, name, role)
    values (v_tenant, 'SEED Cashier', 'cashier')
    returning id into v_staff;

  insert into public.products (tenant_id, name, category)
    values (v_tenant, 'SEED Cotton Shirt', 'Apparel')
    returning id into v_product;

  insert into public.variants
    (tenant_id, product_id, sku, size, color, price, moving_average_cost, reorder_threshold)
  values
    (v_tenant, v_product, 'SEED-FAST-01',     'M',  'Indigo', 1499.00, 700.00, 20),
    (v_tenant, v_product, 'SEED-STEADY-02',   'L',  'White',  1299.00, 600.00, 10),
    (v_tenant, v_product, 'SEED-STOCKOUT-03', 'S',  'Black',  1399.00, 650.00, 15),
    (v_tenant, v_product, 'SEED-BOUNDARY-04', 'M',  'Olive',  1199.00, 550.00, 10),
    (v_tenant, v_product, 'SEED-SPARSE-05',   'XL', 'Maroon', 1899.00, 900.00,  4),
    (v_tenant, v_product, 'SEED-NEW-06',      'M',  'Sand',   1099.00, 500.00,  6);

  select id into v_fast     from public.variants where tenant_id = v_tenant and sku = 'SEED-FAST-01';
  select id into v_steady   from public.variants where tenant_id = v_tenant and sku = 'SEED-STEADY-02';
  select id into v_stockout from public.variants where tenant_id = v_tenant and sku = 'SEED-STOCKOUT-03';
  select id into v_boundary from public.variants where tenant_id = v_tenant and sku = 'SEED-BOUNDARY-04';
  select id into v_sparse   from public.variants where tenant_id = v_tenant and sku = 'SEED-SPARSE-05';
  select id into v_new      from public.variants where tenant_id = v_tenant and sku = 'SEED-NEW-06';

  ---------------------------------------------------------------------------
  -- Opening stock. Sized so each variant ends the window holding a plausible
  -- quantity — low enough that the reorder arithmetic actually fires, high
  -- enough not to run deep negative.
  ---------------------------------------------------------------------------
  insert into public.stock_movements
    (tenant_id, variant_id, movement_type, quantity_delta, reason_note, created_by, created_at)
  values
    (v_tenant, v_fast,     'receive', 1400, 'SEED opening stock', v_staff, ((current_date - 92)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata'),
    (v_tenant, v_steady,   'receive',  560, 'SEED opening stock', v_staff, ((current_date - 92)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata'),
    (v_tenant, v_stockout, 'receive',  207, 'SEED opening stock', v_staff, ((current_date - 92)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata'),
    (v_tenant, v_boundary, 'receive',  260, 'SEED opening stock', v_staff, ((current_date - 63)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata'),
    (v_tenant, v_sparse,   'receive',   40, 'SEED opening stock', v_staff, ((current_date - 92)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata'),
    (v_tenant, v_new,      'receive',   60, 'SEED opening stock', v_staff, ((current_date - 10)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata');

  -- The restock that ends SEED-STOCKOUT-03's outage. The window between the
  -- balance hitting zero and this receipt is what makes the censoring
  -- reconstructible from the ledger.
  insert into public.stock_movements
    (tenant_id, variant_id, movement_type, quantity_delta, reason_note, created_by, created_at)
  values
    (v_tenant, v_stockout, 'receive', 180, 'SEED restock after stockout', v_staff,
     ((current_date - 33)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata');

  ---------------------------------------------------------------------------
  -- Demand. One sale per variant per trading day; the rollup aggregates by
  -- (variant, business day), so this is indistinguishable from a busier day as
  -- far as Phase 6's input contract is concerned.
  --
  -- Quantities use a deterministic `d % n` wobble rather than random(): the
  -- series should not be a perfect step function (a model that fits it exactly
  -- is overfitting, and the fixture should be able to reveal that), but it must
  -- be reproducible so two people comparing results are looking at one dataset.
  ---------------------------------------------------------------------------
  for d in reverse 91 .. 0 loop
    sale_at := ((current_date - d)::timestamp + interval '14 hours') at time zone 'Asia/Kolkata';
    dow := extract(isodow from (current_date - d));  -- 6 = Sat, 7 = Sun

    -- Weekday ~11, weekend ~22.
    qty := (case when dow >= 6 then 21 else 10 end) + (d % 3);
    perform public.seed_record_sale(v_tenant, v_fast, qty, 1499.00, sale_at, v_staff);

    -- Flat. No weekly signal to find.
    qty := 5 + (d % 2);
    perform public.seed_record_sale(v_tenant, v_steady, qty, 1299.00, sale_at, v_staff);

    -- ~4.5/day, then nothing at all for 12 days while stock sits at zero.
    -- No sale row is written during the gap, which is exactly what the rollup
    -- and the model will see: an absence, not a recorded zero.
    if d not between 34 and 45 then
      qty := 4 + (d % 2);
      perform public.seed_record_sale(v_tenant, v_stockout, qty, 1399.00, sale_at, v_staff);
    end if;

    -- First sale 61 days ago -> 62 days of history counting today.
    if d <= 61 then
      qty := 3 + (d % 3);
      perform public.seed_record_sale(v_tenant, v_boundary, qty, 1199.00, sale_at, v_staff);
    end if;

    -- One unit roughly every fifth day.
    if d % 5 = 0 then
      perform public.seed_record_sale(v_tenant, v_sparse, 1, 1899.00, sale_at, v_staff);
    end if;

    -- Only the last 9 days.
    if d <= 8 then
      qty := 2 + (d % 2);
      perform public.seed_record_sale(v_tenant, v_new, qty, 1099.00, sale_at, v_staff);
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- One placed purchase order. 'sent' counts toward on_order; a draft does
  -- not. Sized so it reduces SEED-FAST-01's suggestion without eliminating it
  -- — a fixture where on_order happens to zero the answer cannot tell you
  -- whether the subtraction ran at all.
  ---------------------------------------------------------------------------
  insert into public.purchase_orders
    (tenant_id, supplier_id, po_number, status, expected_date, created_by)
  values
    (v_tenant, v_supplier, 'SEED-PO-0001', 'sent', current_date + 5, v_staff)
  returning id into v_po;

  insert into public.purchase_order_lines
    (tenant_id, purchase_order_id, variant_id, quantity_ordered, quantity_received, unit_cost)
  values
    (v_tenant, v_po, v_fast, 60, 0, 700.00);
end $$;

drop function public.seed_record_sale(uuid, uuid, integer, numeric, timestamptz, uuid);

commit;
