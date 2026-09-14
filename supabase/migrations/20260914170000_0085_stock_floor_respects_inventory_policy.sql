-- 0085 — make the stock-floor policy database-authoritative for sales.
--
-- Older migrations deliberately allowed every `sale` movement to push a
-- balance negative (the historical D-17 carve-out). Phase 5 makes the
-- merchant's variant policy explicit instead: a tracked variant with
-- allow_negative_stock = false must remain unsellable. The route performs a
-- friendly pre-check, but this trigger is the concurrency-safe authority: the
-- upsert locks (variant, store), then the resulting balance is checked before
-- the movement can commit.

CREATE OR REPLACE FUNCTION public.apply_stock_movement() RETURNS trigger AS $$
DECLARE
  resulting_qty numeric(12,3);
  should_track boolean;
  may_go_negative boolean;
  variant_threshold numeric(12,3);
  variant_name text;
  product_name text;
  store_name text;
BEGIN
  SELECT track_inventory, allow_negative_stock
    INTO should_track, may_go_negative
  FROM public.variants
  WHERE id = new.variant_id;

  -- Made-to-order/untracked items retain their append-only audit row but do
  -- not create a meaningless stock balance or participate in the floor guard.
  IF NOT coalesce(should_track, true) THEN
    RETURN new;
  END IF;

  INSERT INTO public.variant_stock_levels (variant_id, store_id, tenant_id, quantity, updated_at)
  VALUES (new.variant_id, new.store_id, new.tenant_id, new.quantity_delta, now())
  ON CONFLICT (variant_id, store_id) DO UPDATE
    SET quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now()
  RETURNING quantity INTO resulting_qty;

  -- Adjustments/transfers remain floor-guarded even when a merchant permits
  -- checkout oversell. A negative sale is allowed only when the merchant
  -- explicitly opted in. The row lock obtained by the upsert makes concurrent
  -- checkouts serialize before this decision is made.
  IF new.quantity_delta < 0
    AND resulting_qty < 0
    AND (new.movement_type <> 'sale' OR NOT coalesce(may_go_negative, false)) THEN
    RAISE EXCEPTION 'Stock movement would take variant % at store % below zero (currently %, delta %)',
      new.variant_id, new.store_id, resulting_qty - new.quantity_delta, new.quantity_delta
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.variants SET identity_locked = true
    WHERE id = new.variant_id AND identity_locked = false;

  SELECT v.reorder_threshold, v.sku, p.name
    INTO variant_threshold, variant_name, product_name
  FROM public.variants v
  JOIN public.products p ON p.id = v.product_id
  WHERE v.id = new.variant_id;

  SELECT s.name INTO store_name FROM public.stores s WHERE s.id = new.store_id;

  IF resulting_qty <= variant_threshold AND NOT EXISTS (
    SELECT 1
    FROM public.notifications
    WHERE tenant_id = new.tenant_id
      AND store_id = new.store_id
      AND type = 'stock_low'
      AND read_at IS NULL
      AND metadata->>'variantId' = new.variant_id::text
  ) THEN
    INSERT INTO public.notifications (tenant_id, store_id, type, title, body, link, metadata)
    VALUES (
      new.tenant_id,
      new.store_id,
      'stock_low',
      product_name || ' is low on stock at ' || coalesce(store_name, 'your store'),
      variant_name || ' has ' || resulting_qty || ' left at ' || coalesce(store_name, 'your store')
        || ', at or below its reorder point of ' || variant_threshold || '.',
      '/app/inventory/catalog/' || new.variant_id,
      jsonb_build_object('variantId', new.variant_id, 'storeId', new.store_id)
    );
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
