-- 0033 — real notifications. The bell icon and /app/notifications have been
-- dead links to UnavailableModulePage; this gives them something real.
--
-- Tenant-scoped, not per-user: every notification is visible to every staff
-- member on the tenant, matching the RLS pattern already used everywhere else
-- and this app's few-staff-per-shop scale. "Read" is a single boolean gate —
-- opening /app/notifications marks everything visible as read at once. No
-- per-item dismiss, no delete: history persists as a lightweight log.
--
-- Four trigger types for V1, deliberately not an exhaustive list — the
-- mechanism (one row insert at the point the event happens) is what's
-- designed to be cheap to extend, not the type list:
--   business_type_unset — once, at signup
--   po_received         — a purchase order's status flips to 'received'
--   staff_activated     — a staff member's pin_hash is set for the first time
--   stock_low           — a stock movement lands a variant at/below its
--                          reorder threshold, deduped against any existing
--                          unread stock_low notification for that variant

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('business_type_unset', 'po_received', 'staff_activated', 'stock_low')),
  title text NOT NULL,
  body text NOT NULL,
  -- Where clicking the notification takes the owner. Relative app path.
  link text,
  -- Free-form per-type context (variantId for stock_low, purchaseOrderId for
  -- po_received, staffMemberId for staff_activated). Never rendered directly.
  metadata jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_id ON public.notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_unread
  ON public.notifications(tenant_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_notifications ON public.notifications
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON public.notifications TO app_runtime;

-- stock_low generation --------------------------------------------------------
--
-- Re-declares apply_stock_movement() again (0031 was the last version) to add
-- one insert after the existing floor-guard logic. Everything above the new
-- block is byte-for-byte 0031's body.
--
-- Dedup strategy: only insert if this variant has no existing UNREAD
-- stock_low notification. This sidesteps precisely detecting "crossed the
-- threshold this movement" (which would need a pre-upsert read of the old
-- balance — the exact pattern 0019's header explains was a race condition
-- when the floor-guard depended on it). Here the stakes are only a UI
-- notification, not stock correctness, so "at most one unread low-stock ping
-- per variant" is a safe, sufficient rule: reading it (which marks it read,
-- per this migration's read semantics) clears the way for a fresh one later.
CREATE OR REPLACE FUNCTION public.apply_stock_movement() RETURNS trigger AS $$
declare
  resulting_qty numeric(12,3);
  variant_threshold numeric(12,3);
  variant_name text;
  product_name text;
begin
  insert into public.variant_stock_levels (variant_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now()
  returning quantity into resulting_qty;

  if new.quantity_delta < 0 and new.movement_type <> 'sale' and resulting_qty < 0 then
    raise exception 'Stock movement would take variant % below zero (currently %, delta %)',
      new.variant_id, resulting_qty - new.quantity_delta, new.quantity_delta
      using errcode = '23514';
  end if;

  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  select v.reorder_threshold, v.sku, p.name
    into variant_threshold, variant_name, product_name
  from public.variants v
  join public.products p on p.id = v.product_id
  where v.id = new.variant_id;

  if resulting_qty <= variant_threshold and not exists (
    select 1 from public.notifications
    where tenant_id = new.tenant_id
      and type = 'stock_low'
      and read_at is null
      and metadata->>'variantId' = new.variant_id::text
  ) then
    insert into public.notifications (tenant_id, type, title, body, link, metadata)
    values (
      new.tenant_id,
      'stock_low',
      product_name || ' is low on stock',
      variant_name || ' has ' || resulting_qty || ' left, at or below its reorder point of ' || variant_threshold || '.',
      '/app/inventory/catalog/' || new.variant_id,
      jsonb_build_object('variantId', new.variant_id)
    );
  end if;

  return new;
end;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- po_received generation -------------------------------------------------------
--
-- Re-declares apply_purchase_receipt_line() (last version: 0031) to fire once,
-- on the actual sent/partial -> received transition. Reads the PO's status
-- before this receipt line's update, same as 0031 already reads stock_before
-- for the cost calculation — this route is not the high-concurrency path
-- 0019 was fixing (a single receipt line, not many simultaneous adjustments),
-- so a plain pre-read is fine here.
CREATE OR REPLACE FUNCTION public.apply_purchase_receipt_line() RETURNS trigger AS $$
declare
  stock_before numeric(12,3);
  average_before numeric(10, 2);
  po_id uuid;
  po_status_before public.purchase_order_status;
  supplier_name text;
  total_ordered numeric(12,3);
  total_received numeric(12,3);
  new_status public.purchase_order_status;
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

  select po.status, s.name into po_status_before, supplier_name
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    where po.id = po_id;

  select sum(quantity_ordered), sum(quantity_received)
    into total_ordered, total_received
  from public.purchase_order_lines where purchase_order_id = po_id;

  new_status := case when total_received >= total_ordered then 'received' else 'partial' end;

  update public.purchase_orders
    set status = new_status::public.purchase_order_status
    where id = po_id and status <> 'cancelled';

  -- Mirrors the update's own WHERE guard: a cancelled PO's status is never
  -- actually written above, so it must not fire a notification either.
  if new_status = 'received'
     and po_status_before is distinct from 'received'
     and po_status_before is distinct from 'cancelled' then
    insert into public.notifications (tenant_id, type, title, body, link, metadata)
    values (
      new.tenant_id,
      'po_received',
      'Purchase order fully received',
      coalesce('Everything ordered from ' || supplier_name || ' has arrived.', 'A purchase order has been fully received.'),
      '/app/purchases',
      jsonb_build_object('purchaseOrderId', po_id)
    );
  end if;

  return new;
end;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
