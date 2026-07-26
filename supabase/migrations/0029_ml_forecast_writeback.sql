-- ML-02: privileged write-only adapter for the isolated forecast role.
-- The Python role provides forecast statistics; this function reads current
-- stock/on-order/supplier context without granting it any operational tables.

begin;

create or replace function public.ml_write_forecast_suggestion(
  p_tenant_id uuid, p_variant_id uuid, p_demand numeric, p_lower numeric,
  p_upper numeric, p_model text, p_wape numeric, p_heuristic_wape numeric,
  p_history_days integer, p_window_days integer, p_units_sold integer,
  p_returns integer, p_net_units integer, p_daily_velocity numeric
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_stock integer := 0; v_on_order integer := 0; v_supplier uuid; v_name text;
  v_lead integer := 7; v_safety integer; v_raw numeric; v_qty integer; v_conf public.reorder_confidence;
begin
  if current_setting('app.tenant_id', true)::uuid is distinct from p_tenant_id then
    raise exception 'ML write tenant does not match RLS context' using errcode = '42501';
  end if;
  select quantity into v_stock from public.variant_stock_levels where variant_id=p_variant_id;
  v_stock := coalesce(v_stock,0);
  select po.supplier_id, s.name, s.lead_time_days, coalesce(sum(pol.quantity_ordered-pol.quantity_received),0)
    into v_supplier,v_name,v_lead,v_on_order
  from public.purchase_order_lines pol join public.purchase_orders po on po.id=pol.purchase_order_id
  join public.suppliers s on s.id=po.supplier_id
  where pol.tenant_id=p_tenant_id and pol.variant_id=p_variant_id and po.status in ('sent','partial')
  group by po.supplier_id,s.name,s.lead_time_days order by max(po.created_at) desc limit 1;
  if v_supplier is null then select id,name,lead_time_days into v_supplier,v_name,v_lead from public.suppliers where tenant_id=p_tenant_id and is_active order by name limit 1; end if;
  if v_supplier is null then return; end if;
  v_on_order:=coalesce(v_on_order,0); v_lead:=coalesce(v_lead,7);
  v_safety:=greatest(0,ceil(p_upper-p_demand)::integer); v_raw:=p_demand+v_safety-v_stock-v_on_order; v_qty:=greatest(1,ceil(v_raw)::integer);
  v_conf:=case when (p_upper-p_lower)/greatest(p_demand,1) <= .35 then 'high' when (p_upper-p_lower)/greatest(p_demand,1) <= .8 then 'medium' else 'low' end;
  insert into public.reorder_suggestions (tenant_id,variant_id,supplier_id,suggested_quantity,reason,method,confidence,generated_at)
  values (p_tenant_id,p_variant_id,v_supplier,v_qty,jsonb_build_object('formula','forecast_interval_reorder','windowDays',p_window_days,'historyDays',p_history_days,'unitsSoldInWindow',p_units_sold,'returnsInWindow',p_returns,'netUnitsInWindow',p_net_units,'dailyVelocity',p_daily_velocity,'leadTimeDays',v_lead,'leadTimeDemand',p_demand,'safetyDays',null,'safetyStock',v_safety,'reorderPoint',p_demand+v_safety,'reviewPeriodDays',0,'reviewPeriodDemand',0,'currentStock',v_stock,'onOrder',v_on_order,'rawSuggestion',v_raw,'supplierName',v_name,'forecastDemand',p_demand,'forecastLower',p_lower,'forecastUpper',p_upper,'model',p_model,'forecastWape',p_wape,'heuristicWape',p_heuristic_wape),'forecast',v_conf,now())
  on conflict (tenant_id,variant_id,((generated_at at time zone 'UTC')::date)) do update set suggested_quantity=excluded.suggested_quantity,reason=excluded.reason,method='forecast',confidence=excluded.confidence,generated_at=excluded.generated_at,supplier_id=excluded.supplier_id;
end $$;

revoke all on function public.ml_write_forecast_suggestion(uuid,uuid,numeric,numeric,numeric,text,numeric,numeric,integer,integer,integer,integer,integer,numeric) from public;
grant execute on function public.ml_write_forecast_suggestion(uuid,uuid,numeric,numeric,numeric,text,numeric,numeric,integer,integer,integer,integer,integer,numeric) to ml_forecast;
commit;
