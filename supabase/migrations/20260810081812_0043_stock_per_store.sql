-- 0043 — stock is held per store.
--
-- THE MOST DELICATE MIGRATION IN THIS PHASE. Read 0008 (trigger-derived levels),
-- 0009 (floor guard), 0010 (sale carve-out, D-17) and 0019 (direction) before
-- changing anything here.
--
-- The invariant that must survive, verified live 2026-08-10:
--   variant_stock_levels -> app_runtime has SELECT only
--   stock_movements      -> app_runtime has INSERT, SELECT only
-- Current stock is derived by this SECURITY DEFINER trigger and by nothing
-- else, and the ledger is append-only because no UPDATE/DELETE grant exists.
-- Do NOT grant UPDATE on variant_stock_levels to make anything below easier —
-- that grant is the product's central claim about trustworthy stock.
--
-- What changes: "we have 12 blue shirts" becomes "Andheri has 5, Bandra has 7".
-- What does not change: the append-only ledger, the derivation, the grants, the
-- D-17 sale carve-out, and the D-04 identity lock.

-- Movements name their store ------------------------------------------------

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

UPDATE public.stock_movements sm
SET store_id = s.id
FROM public.stores s
WHERE s.tenant_id = sm.tenant_id
  AND sm.store_id IS NULL;

ALTER TABLE public.stock_movements
  ALTER COLUMN store_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_store_id
  ON public.stock_movements(store_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_store_variant
  ON public.stock_movements(store_id, variant_id);

-- Levels become per (variant, store) ----------------------------------------

ALTER TABLE public.variant_stock_levels
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

UPDATE public.variant_stock_levels vsl
SET store_id = s.id
FROM public.stores s
WHERE s.tenant_id = vsl.tenant_id
  AND vsl.store_id IS NULL;

ALTER TABLE public.variant_stock_levels
  ALTER COLUMN store_id SET NOT NULL;

-- The primary key widens. Every existing row already belongs to the tenant's
-- single 0041 store, so this repoints the key without moving any quantity:
-- a single-shop owner's numbers are byte-identical before and after.
ALTER TABLE public.variant_stock_levels
  DROP CONSTRAINT variant_stock_levels_pkey;

ALTER TABLE public.variant_stock_levels
  ADD CONSTRAINT variant_stock_levels_pkey PRIMARY KEY (variant_id, store_id);

CREATE INDEX IF NOT EXISTS idx_variant_stock_levels_store_id
  ON public.variant_stock_levels(store_id);

-- Notifications name their store --------------------------------------------
--
-- Pulled forward from task 4 because the trigger below writes stock_low
-- notifications and its duplicate-suppression check needs the column. Leaving
-- it to a later migration would mean shipping a trigger that suppresses the
-- second shop's alert using the first shop's unread one.
--
-- DELIBERATE EXCEPTION to this phase's no-nullable-store_id rule: store_id here
-- stays NULLABLE, and null carries real meaning — "this notification is about
-- the business, not about one shop". A failed subscription payment belongs to
-- the business; a low-stock alert belongs to a shelf. This is a genuine
-- semantic, not the legacy-hedge nullable the rule exists to prevent.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

UPDATE public.notifications n
SET store_id = s.id
FROM public.stores s
WHERE s.tenant_id = n.tenant_id
  AND n.store_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_store_id
  ON public.notifications(store_id);

-- The trigger ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_stock_movement() RETURNS trigger AS $$
declare
  resulting_qty numeric(12,3);
  variant_threshold numeric(12,3);
  variant_name text;
  product_name text;
  store_name text;
begin
  -- Scoped to (variant, store). Andheri's shelf and Bandra's shelf are now
  -- separate rows that never touch each other.
  insert into public.variant_stock_levels (variant_id, store_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.store_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id, store_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now()
  returning quantity into resulting_qty;

  -- Floor guard now counts the SELLING shop's balance. Without the store scope
  -- above, Andheri could draw stock down against a business-wide total and sell
  -- shirts physically sitting in Bandra.
  --
  -- D-17 carve-out preserved verbatim: a 'sale' may go negative (an oversell is
  -- recorded honestly rather than blocked at the till), every other negative
  -- direction is refused.
  if new.quantity_delta < 0 and new.movement_type <> 'sale' and resulting_qty < 0 then
    raise exception 'Stock movement would take variant % at store % below zero (currently %, delta %)',
      new.variant_id, new.store_id, resulting_qty - new.quantity_delta, new.quantity_delta
      using errcode = '23514';
  end if;

  -- D-04 identity lock stays variant-wide, NOT per store. Size/colour/material
  -- are properties of the product, not of a shelf — locking them per store
  -- would let Bandra rename a variant that Andheri has already sold.
  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  select v.reorder_threshold, v.sku, p.name
    into variant_threshold, variant_name, product_name
  from public.variants v
  join public.products p on p.id = v.product_id
  where v.id = new.variant_id;

  select s.name into store_name from public.stores s where s.id = new.store_id;

  -- Low stock is a per-shop fact: Andheri being out matters even when Bandra is
  -- full. The suppression check MUST match on store as well as variant, or the
  -- first shop's unread alert silently swallows every other shop's.
  if resulting_qty <= variant_threshold and not exists (
    select 1 from public.notifications
    where tenant_id = new.tenant_id
      and store_id = new.store_id
      and type = 'stock_low'
      and read_at is null
      and metadata->>'variantId' = new.variant_id::text
  ) then
    insert into public.notifications (tenant_id, store_id, type, title, body, link, metadata)
    values (
      new.tenant_id,
      new.store_id,
      'stock_low',
      product_name || ' is low on stock at ' || coalesce(store_name, 'your store'),
      variant_name || ' has ' || resulting_qty || ' left at ' || coalesce(store_name, 'your store')
        || ', at or below its reorder point of ' || variant_threshold || '.',
      '/app/inventory/catalog/' || new.variant_id,
      jsonb_build_object('variantId', new.variant_id, 'storeId', new.store_id)
    );
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Re-assert the invariant. If any statement above accidentally widened
-- app_runtime's access to the derived table, fail the migration rather than
-- ship a writable stock level.
DO $$
DECLARE
  bad_privs text;
BEGIN
  SELECT string_agg(privilege_type, ',') INTO bad_privs
  FROM information_schema.role_table_grants
  WHERE grantee = 'app_runtime'
    AND table_schema = 'public'
    AND table_name = 'variant_stock_levels'
    AND privilege_type <> 'SELECT';

  IF bad_privs IS NOT NULL THEN
    RAISE EXCEPTION 'app_runtime must have SELECT only on variant_stock_levels, found: %', bad_privs;
  END IF;
END
$$;
