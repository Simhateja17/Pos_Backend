-- 0051 — the ML seam becomes per-store.
--
-- NUMBERING NOTE: applied to the live project as `ml_functions_per_store`
-- (version 20260810105846) while still numbered 0050, before a parallel
-- barcode workstream claimed 0050. Renumbered to 0051 to resolve the clash.
-- The two are independent — no ordering dependency either way — so the file
-- order no longer matching the applied order is harmless here.
--
-- FIXES A LIVE BREAK. 0044 replaced the unique index
-- idx_reorder_suggestions_tenant_variant_day with a store-aware one, but
-- ml_write_forecast_suggestion's ON CONFLICT still named the old
-- (tenant_id, variant_id, day) target. That index no longer exists, so the
-- nightly job would have failed outright on its first write. Caught while
-- wiring task 10; there was no working state to preserve.
--
-- Both functions also read stock and movements business-wide, which is wrong
-- now for reasons that do not announce themselves:
--   * ml_write_forecast_suggestion took an arbitrary shop's stock level
--     (`select quantity into v_stock ... where variant_id = ...` silently keeps
--     the first of several rows) and counted every shop's inbound purchase
--     orders as stock arriving at this one.
--   * ml_stockout_dates summed movements across all shops, so a variant sold
--     out at Andheri but sitting on Bandra's shelf never registered as a
--     stockout — and stockout days are exactly what the forecast must exclude
--     to avoid learning "demand was zero" from "we had none to sell".
--
-- Signatures change, so the old ones are dropped rather than overloaded: an
-- overload would let the deployed job keep calling the business-wide version
-- and silently write suggestions for the wrong shop.

DROP FUNCTION IF EXISTS public.ml_write_forecast_suggestion(
  uuid, uuid, numeric, numeric, numeric, text, numeric, numeric,
  integer, integer, integer, integer, integer, numeric
);
DROP FUNCTION IF EXISTS public.ml_stockout_dates(uuid, uuid, date, date);

CREATE FUNCTION public.ml_stockout_dates(
  p_tenant_id uuid,
  p_store_id uuid,
  p_variant_id uuid,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(stockout_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_timezone text;
begin
  if current_setting('app.tenant_id', true)::uuid is distinct from p_tenant_id then
    raise exception 'ML stockout query tenant does not match RLS context' using errcode = '42501';
  end if;

  select timezone into v_timezone from public.tenants where id = p_tenant_id;
  if v_timezone is null then
    raise exception 'Tenant not found' using errcode = 'P0002';
  end if;

  return query
  select d::date
  from generate_series(p_start_date, p_end_date, interval '1 day') as d
  where coalesce((
    select sum(sm.quantity_delta)
    from public.stock_movements sm
    where sm.tenant_id = p_tenant_id
      -- The whole point: a day is a stockout for THIS shop's shelf.
      and sm.store_id = p_store_id
      and sm.variant_id = p_variant_id
      and (sm.created_at at time zone v_timezone)::date <= d::date
  ), 0) = 0;
end;
$function$;

CREATE FUNCTION public.ml_write_forecast_suggestion(
  p_tenant_id uuid,
  p_store_id uuid,
  p_variant_id uuid,
  p_demand numeric,
  p_lower numeric,
  p_upper numeric,
  p_model text,
  p_wape numeric,
  p_heuristic_wape numeric,
  p_history_days integer,
  p_window_days integer,
  p_units_sold integer,
  p_returns integer,
  p_net_units integer,
  p_daily_velocity numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_stock numeric := 0;
  v_on_order numeric := 0;
  v_supplier uuid;
  v_name text;
  v_lead integer := 7;
  v_safety integer;
  v_raw numeric;
  v_qty integer;
  v_conf public.reorder_confidence;
begin
  if current_setting('app.tenant_id', true)::uuid is distinct from p_tenant_id then
    raise exception 'ML write tenant does not match RLS context' using errcode = '42501';
  end if;

  -- This shop's shelf, not an arbitrary one.
  select quantity into v_stock
  from public.variant_stock_levels
  where variant_id = p_variant_id and store_id = p_store_id;
  v_stock := coalesce(v_stock, 0);

  -- Only orders inbound to THIS shop count as stock already coming. Another
  -- outlet's delivery does not restock this one, and counting it would
  -- suppress a suggestion this shop genuinely needs.
  select po.supplier_id, s.name, s.lead_time_days,
         coalesce(sum(pol.quantity_ordered - pol.quantity_received), 0)
    into v_supplier, v_name, v_lead, v_on_order
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  join public.suppliers s on s.id = po.supplier_id
  where pol.tenant_id = p_tenant_id
    and pol.variant_id = p_variant_id
    and po.store_id = p_store_id
    and po.status in ('sent', 'partial')
  group by po.supplier_id, s.name, s.lead_time_days
  order by max(po.created_at) desc
  limit 1;

  if v_supplier is null then
    select id, name, lead_time_days into v_supplier, v_name, v_lead
    from public.suppliers
    where tenant_id = p_tenant_id and is_active
    order by name
    limit 1;
  end if;

  -- No supplier means no lead time, and without a lead time there is no
  -- reorder point at all. Silence beats a number with no basis.
  if v_supplier is null then
    return;
  end if;

  v_on_order := coalesce(v_on_order, 0);
  v_lead := coalesce(v_lead, 7);
  v_safety := greatest(0, ceil(p_upper - p_demand)::integer);
  v_raw := p_demand + v_safety - v_stock - v_on_order;
  v_qty := greatest(1, ceil(v_raw)::integer);
  v_conf := case
    when (p_upper - p_lower) / greatest(p_demand, 1) <= .35 then 'high'
    when (p_upper - p_lower) / greatest(p_demand, 1) <= .8 then 'medium'
    else 'low'
  end;

  insert into public.reorder_suggestions(
    tenant_id, store_id, variant_id, supplier_id, suggested_quantity,
    reason, method, confidence, generated_at
  )
  values (
    p_tenant_id, p_store_id, p_variant_id, v_supplier, v_qty,
    jsonb_build_object(
      'formula', 'forecast_interval_reorder',
      'windowDays', p_window_days, 'historyDays', p_history_days,
      'unitsSoldInWindow', p_units_sold, 'returnsInWindow', p_returns,
      'netUnitsInWindow', p_net_units, 'dailyVelocity', p_daily_velocity,
      'leadTimeDays', v_lead, 'leadTimeDemand', p_demand,
      'safetyDays', 0, 'safetyStock', v_safety,
      'reorderPoint', p_demand + v_safety,
      'reviewPeriodDays', 0, 'reviewPeriodDemand', 0,
      'currentStock', v_stock, 'onOrder', v_on_order, 'rawSuggestion', v_raw,
      'supplierName', v_name,
      'forecastDemand', p_demand, 'forecastLower', p_lower, 'forecastUpper', p_upper,
      'model', p_model, 'forecastWape', p_wape, 'heuristicWape', p_heuristic_wape,
      -- The maturity indicator gains a level (task 10): the UI must be able to
      -- say WHERE a number came from, not merely how confident it is.
      'basis', 'this_store'
    ),
    'forecast', v_conf, now()
  )
  -- Matches 0044's widened index. The old target no longer exists.
  on conflict (tenant_id, store_id, variant_id, ((generated_at at time zone 'UTC')::date))
  do update set
    suggested_quantity = excluded.suggested_quantity,
    reason = excluded.reason,
    method = 'forecast',
    confidence = excluded.confidence,
    generated_at = excluded.generated_at,
    supplier_id = excluded.supplier_id;
end;
$function$;

-- DROP discards the old ACLs, so both must be re-granted. Per 0049's standing
-- rule, revoke the CREATE-time EXECUTE-to-PUBLIC in the same migration —
-- otherwise PostgREST exposes these as anonymous RPC endpoints.
REVOKE EXECUTE ON FUNCTION public.ml_stockout_dates(uuid, uuid, uuid, date, date)
  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ml_write_forecast_suggestion(
  uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, numeric,
  integer, integer, integer, integer, integer, numeric
) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ml_stockout_dates(uuid, uuid, uuid, date, date)
  TO ml_forecast;
GRANT EXECUTE ON FUNCTION public.ml_write_forecast_suggestion(
  uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, numeric,
  integer, integer, integer, integer, integer, numeric
) TO ml_forecast;
