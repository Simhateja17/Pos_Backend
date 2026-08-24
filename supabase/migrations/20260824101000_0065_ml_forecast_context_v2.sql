-- 0065 — forecast writeback with an operational horizon and complete reason.
-- The legacy adapter remains available for already deployed nightly clients;
-- the manual worker uses this version so its stored arithmetic is auditable.

begin;

create or replace function public.ml_forecast_variant_context(
  p_tenant_id uuid, p_store_id uuid, p_variant_id uuid
)
returns table (
  supplier_id uuid,
  supplier_name text,
  lead_time_days integer,
  current_stock numeric,
  on_order numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML context tenant does not match RLS context' using errcode = '42501';
  end if;

  return query
  with primary_supplier as (
    select sp.supplier_id, s.name supplier_name,
           coalesce(sp.lead_time_days, s.lead_time_days, 7) lead_time_days
    from public.supplier_products sp
    join public.suppliers s on s.id = sp.supplier_id
    where sp.tenant_id = p_tenant_id and sp.variant_id = p_variant_id and s.is_active
    order by sp.is_primary desc, sp.created_at asc
    limit 1
  ), fallback_supplier as (
    select s.id supplier_id, s.name supplier_name, s.lead_time_days
    from public.suppliers s
    where s.tenant_id = p_tenant_id and s.is_active
    order by s.name
    limit 1
  ), inbound as (
    select coalesce(sum(greatest(0, pol.quantity_ordered - pol.quantity_received)), 0) on_order
    from public.purchase_order_lines pol
    join public.purchase_orders po on po.id = pol.purchase_order_id
    where pol.tenant_id = p_tenant_id and pol.variant_id = p_variant_id
      and po.store_id = p_store_id and po.status in ('sent', 'partial')
  )
  select coalesce(ps.supplier_id, fs.supplier_id),
         coalesce(ps.supplier_name, fs.supplier_name),
         coalesce(ps.lead_time_days, fs.lead_time_days, 7),
         coalesce(vsl.quantity, 0), coalesce(i.on_order, 0)
  from primary_supplier ps
  full join fallback_supplier fs on true
  left join public.variant_stock_levels vsl
    on vsl.tenant_id = p_tenant_id and vsl.variant_id = p_variant_id and vsl.store_id = p_store_id
  cross join inbound i;
end;
$function$;

create or replace function public.ml_write_forecast_suggestion_v2(
  p_tenant_id uuid,
  p_store_id uuid,
  p_variant_id uuid,
  p_demand numeric,
  p_lower numeric,
  p_upper numeric,
  p_lead_time_demand numeric,
  p_review_period_demand numeric,
  p_standard_14_demand numeric,
  p_model text,
  p_wape numeric,
  p_heuristic_wape numeric,
  p_history_days integer,
  p_window_days integer,
  p_units_sold integer,
  p_returns integer,
  p_net_units integer,
  p_daily_velocity numeric,
  p_review_days integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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
  v_review integer := greatest(0, coalesce(p_review_days, 7));
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML write tenant does not match RLS context' using errcode = '42501';
  end if;

  select quantity into v_stock
  from public.variant_stock_levels
  where tenant_id = p_tenant_id and variant_id = p_variant_id and store_id = p_store_id;
  v_stock := coalesce(v_stock, 0);

  select coalesce(sum(greatest(0, pol.quantity_ordered - pol.quantity_received)), 0)
    into v_on_order
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where pol.tenant_id = p_tenant_id and pol.variant_id = p_variant_id
    and po.store_id = p_store_id and po.status in ('sent', 'partial');

  select sp.supplier_id, s.name, coalesce(sp.lead_time_days, s.lead_time_days, 7)
      into v_supplier, v_name, v_lead
    from public.supplier_products sp
    join public.suppliers s on s.id = sp.supplier_id
    where sp.tenant_id = p_tenant_id and sp.variant_id = p_variant_id and s.is_active
    order by sp.is_primary desc, sp.created_at asc
    limit 1;
  if v_supplier is null then
    select id, name, lead_time_days into v_supplier, v_name, v_lead
    from public.suppliers where tenant_id = p_tenant_id and is_active order by name limit 1;
  end if;
  if v_supplier is null then return; end if;

  v_lead := greatest(0, coalesce(v_lead, 7));
  v_on_order := coalesce(v_on_order, 0);
  v_safety := greatest(0, ceil(greatest(0, p_upper - p_demand))::integer);
  v_raw := greatest(0, p_demand) + v_safety - v_stock - v_on_order;
  if v_raw <= 0 then return; end if;
  v_qty := ceil(v_raw)::integer;
  v_conf := case
    when (p_upper - p_lower) / greatest(p_demand, 1) <= .35 then 'high'
    when (p_upper - p_lower) / greatest(p_demand, 1) <= .8 then 'medium'
    else 'low'
  end;

  insert into public.reorder_suggestions(
    tenant_id, store_id, variant_id, supplier_id, suggested_quantity,
    reason, method, confidence, generated_at
  ) values (
    p_tenant_id, p_store_id, p_variant_id, v_supplier, v_qty,
    jsonb_build_object(
      'formula', 'forecast_interval_reorder', 'basis', 'this_store',
      'windowDays', p_window_days, 'historyDays', p_history_days,
      'unitsSoldInWindow', p_units_sold, 'returnsInWindow', p_returns,
      'netUnitsInWindow', p_net_units, 'dailyVelocity', p_daily_velocity,
      'leadTimeDays', v_lead, 'leadTimeDemand', p_lead_time_demand,
      'safetyDays', 0, 'safetyStock', v_safety,
      'reorderPoint', p_lead_time_demand + v_safety,
      'reviewPeriodDays', v_review, 'reviewPeriodDemand', p_review_period_demand,
      'currentStock', v_stock, 'onOrder', v_on_order, 'rawSuggestion', v_raw,
      'supplierName', v_name, 'forecastDemand', p_demand,
      'forecastLower', p_lower, 'forecastUpper', p_upper,
      'forecast14DayDemand', p_standard_14_demand, 'model', p_model,
      'forecastWape', p_wape, 'heuristicWape', p_heuristic_wape
    ),
    'forecast', v_conf, now()
  )
  on conflict (tenant_id, store_id, variant_id, ((generated_at at time zone 'UTC')::date))
  do update set suggested_quantity = excluded.suggested_quantity,
                reason = excluded.reason, method = 'forecast',
                confidence = excluded.confidence, generated_at = excluded.generated_at,
                supplier_id = excluded.supplier_id;
end;
$function$;

revoke execute on function public.ml_write_forecast_suggestion_v2(
  uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric,
  text, numeric, numeric, integer, integer, integer, integer, integer, numeric, integer
) from public, anon, authenticated;
grant execute on function public.ml_write_forecast_suggestion_v2(
  uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric,
  text, numeric, numeric, integer, integer, integer, integer, integer, numeric, integer
) to ml_forecast;

revoke execute on function public.ml_forecast_variant_context(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ml_forecast_variant_context(uuid, uuid, uuid)
  to ml_forecast;

commit;
