-- Teardown for phase-06-forecast-fixture.sql.
--
-- Phases 5 and 7 both left the database clean when they finished, and Phase 6
-- should be able to as well. Deletion order follows the foreign keys inward:
-- rollup and movements are derived from the ledger, so they go first.
--
-- Scoped by the SEED- prefix and by the fixture's own supplier and staff names,
-- so this cannot take anything real with it.

begin;

do $$
declare
  v_tenant uuid := '2df6a042-6af2-41b0-a81c-d453b7607465';
  v_variants uuid[];
  v_sales uuid[];
begin
  select array_agg(id) into v_variants
  from public.variants where tenant_id = v_tenant and sku like 'SEED-%';

  if v_variants is null then
    raise notice 'No SEED- variants found; nothing to remove.';
    return;
  end if;

  select array_agg(distinct sale_id) into v_sales
  from public.sale_line_items where variant_id = any(v_variants);

  delete from public.daily_sales_rollup where variant_id = any(v_variants);
  delete from public.reorder_suggestions where variant_id = any(v_variants);
  delete from public.stock_movements where variant_id = any(v_variants);
  delete from public.purchase_order_lines where variant_id = any(v_variants);
  delete from public.purchase_orders where po_number like 'SEED-%';

  if v_sales is not null then
    delete from public.payments where sale_id = any(v_sales);
    delete from public.sale_line_items where sale_id = any(v_sales);
    delete from public.sales where id = any(v_sales);
  end if;

  delete from public.variants where id = any(v_variants);
  delete from public.products where tenant_id = v_tenant and name like 'SEED %';
  delete from public.suppliers where tenant_id = v_tenant and name like 'SEED %';
  delete from public.staff_members where tenant_id = v_tenant and name like 'SEED %';
end $$;

commit;
