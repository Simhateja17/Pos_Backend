-- WR-04: neither the app-level Zod schema nor the DB previously prevented a
-- quantity_delta (adjustment/transfer) from driving variant_stock_levels.quantity
-- below zero. Since this ledger is the sole source of truth for "current stock"
-- and directly drives the low-stock alert (INV-03) and the future ML reorder
-- signal, a typo'd adjustment (e.g. an extra digit) could silently produce a
-- large negative on-hand count with no error. Replace apply_stock_movement()
-- to compute the resulting balance up front and raise a friendly, catchable
-- error (caught generically as a 400 by stockMovements.ts's POST / handler)
-- instead of allowing the negative balance to persist silently.
create or replace function public.apply_stock_movement() returns trigger as $$
declare
  existing_qty integer;
  resulting_qty integer;
begin
  select quantity into existing_qty
    from public.variant_stock_levels
    where variant_id = new.variant_id;

  resulting_qty := coalesce(existing_qty, 0) + new.quantity_delta;

  if resulting_qty < 0 then
    raise exception 'Stock movement would take variant % below zero (currently %, delta %)',
      new.variant_id, coalesce(existing_qty, 0), new.quantity_delta
      using errcode = '23514';
  end if;

  insert into public.variant_stock_levels (variant_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now();

  -- D-04: lock variant identity attributes the first time any movement references it.
  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
