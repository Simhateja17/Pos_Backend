-- Fixes two defects in the zero-floor guard, both reproduced against the live
-- project during Phase 5 Task 1 (see docs/reference/known-issues-phase-02.md,
-- entries 02-06 and 02-07). INV-02 itself was verified sound -- the trigger's
-- accumulation was always correct; only the guard bolted on in 0009/0010 was
-- wrong. Both defects share one root cause: the guard decided BEFORE the write,
-- from a non-locking read, and judged the resulting sign rather than the
-- movement's direction.
--
-- 02-06: a stock-INCREASING movement was rejected whenever the balance happened
-- to still be negative afterwards. A variant oversold to -72 refused
-- `receive +50` ("would take variant below zero") while `receive +100` was
-- accepted. D-17 deliberately lets `sale` push stock negative so a paying
-- customer is never blocked by a stale count, which makes this state reachable
-- in normal trading -- and once reached, no PARTIAL receipt could be recorded
-- until a single receipt cleared the entire deficit. Phase 5 treats partial
-- receipt as the normal case, so PO receiving against an oversold variant broke
-- outright. A positive delta can never be the cause of a negative balance, so
-- the guard now only considers movements that actually decrease stock.
--
-- 02-07: `select quantity into existing_qty` took no row lock, so concurrent
-- transactions all read the same pre-value and all passed the check. Measured:
-- balance 80, then 20 simultaneous `adjustment -8` inserts -- a correct guard
-- admits exactly 10 and stops at 0; 19 were accepted and the balance landed at
-- -72. The fix is to stop reading separately at all: perform the upsert first
-- and check the value it RETURNS. `on conflict do update` takes a row lock and
-- re-evaluates against the updated row, so a concurrent transaction blocks
-- until the first commits and then sees the true post-value. Raising afterwards
-- aborts the whole insert, since the trigger runs inside its transaction.
create or replace function public.apply_stock_movement() returns trigger as $$
declare
  resulting_qty integer;
begin
  insert into public.variant_stock_levels (variant_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now()
  returning quantity into resulting_qty;

  -- Guard only stock-decreasing movements, and keep D-17's `sale` carve-out.
  -- `return` movements are always positive-delta, so they are unaffected either
  -- way; `adjustment`/`transfer` keep their typo protection.
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
$$ language plpgsql security definer set search_path = public;
