-- D-17: A `sale` movement is allowed to push stock negative -- a paying
-- customer is never blocked by a stale/wrong stock count. `adjustment`/
-- `transfer` remain floor-guarded (typo protection). `return` movements are
-- always positive-delta so they never trip this guard regardless of type.
create or replace function public.apply_stock_movement() returns trigger as $$
declare
  existing_qty integer;
  resulting_qty integer;
begin
  select quantity into existing_qty
    from public.variant_stock_levels
    where variant_id = new.variant_id;

  resulting_qty := coalesce(existing_qty, 0) + new.quantity_delta;

  if new.movement_type <> 'sale' and resulting_qty < 0 then
    raise exception 'Stock movement would take variant % below zero (currently %, delta %)',
      new.variant_id, coalesce(existing_qty, 0), new.quantity_delta
      using errcode = '23514';
  end if;

  insert into public.variant_stock_levels (variant_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now();

  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
