-- 0045 — TRANSITIONAL: default store_id for writers that don't send one yet.
--
-- WHY THIS EXISTS
-- 0043/0044 added NOT NULL store_id (no default) to tables the deployed backend
-- actively writes: sales, stock_movements, shifts, terminals, purchase_orders,
-- purchase_order_receipts. The running code predates Phase 8 and sends no
-- store_id, so every insert began failing with a not-null violation the moment
-- those migrations landed — checkout, receiving, adjustments and shift-open all
-- broken at once.
--
-- This is the "expand" half of expand/contract: accept writes from both the old
-- and new code shapes while the application catches up.
--
-- THIS IS A SHIM AND MUST BE REMOVED.
-- Once the API sends store_id explicitly (Phase 8 task 8), drop these triggers.
-- Leaving them in place is dangerous in a way the current single-shop data
-- hides: with two shops, a writer that forgets store_id would silently have its
-- sale or stock movement attributed to whichever shop happens to be oldest,
-- rather than failing loudly. A wrong shop is worse than a rejected write.
-- Removal is tracked as task 8's definition of done.

CREATE OR REPLACE FUNCTION public.default_store_id() RETURNS trigger AS $$
declare
  fallback_store_id uuid;
begin
  if new.store_id is not null then
    return new;
  end if;

  -- Oldest store for the tenant: for every existing customer that is the shop
  -- backfilled by 0041, i.e. the one all their history already belongs to.
  select s.id into fallback_store_id
  from public.stores s
  where s.tenant_id = new.tenant_id
  order by s.created_at asc, s.id asc
  limit 1;

  if fallback_store_id is null then
    raise exception 'No store exists for tenant % — cannot default store_id', new.tenant_id
      using errcode = '23502';
  end if;

  new.store_id := fallback_store_id;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales','stock_movements','shifts','terminals',
    'purchase_orders','purchase_order_receipts',
    -- reorder_suggestions takes inserts from TWO writers that both predate this
    -- phase: app_runtime (the Phase 5 heuristic service) and ml_forecast (the
    -- nightly job). Neither sends store_id yet.
    'reorder_suggestions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_default_store_id ON public.%I', t);
    -- BEFORE INSERT so the value is in place before 0043's apply_stock_movement
    -- (an AFTER INSERT trigger) reads new.store_id.
    EXECUTE format(
      'CREATE TRIGGER trg_default_store_id BEFORE INSERT ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.default_store_id()', t);
  END LOOP;
END
$$;
