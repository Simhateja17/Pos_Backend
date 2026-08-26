-- 0068 — qualify the run-scope store column in the ML context adapter.
--
-- The function returns a store_id column.  PostgreSQL therefore treats an
-- unqualified `store_id` in the inbound subquery as a possible PL/pgSQL
-- output variable, which prevents a claimed run from starting.

begin;

create or replace function public.ml_forecast_run_context(
  p_tenant_id uuid, p_run_id uuid
)
returns table (
  variant_id uuid,
  store_id uuid,
  supplier_id uuid,
  supplier_name text,
  lead_time_days integer,
  review_period_days integer,
  current_stock numeric,
  on_order numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML context tenant does not match RLS context' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.forecast_runs fr
    where fr.id = p_run_id and fr.tenant_id = p_tenant_id and fr.status = 'running'
  ) then
    raise exception 'Forecast run is not active' using errcode = '40901';
  end if;

  return query
  with run_scope as (
    select fr.store_id
    from public.forecast_runs fr
    where fr.id = p_run_id and fr.tenant_id = p_tenant_id
  ), variants as (
    select distinct dsr.variant_id, rs.store_id
    from public.daily_sales_rollup dsr
    join run_scope rs on rs.store_id = dsr.store_id
    where dsr.tenant_id = p_tenant_id
  ), primary_supplier as (
    select distinct on (sp.variant_id)
      sp.variant_id, sp.supplier_id, s.name supplier_name,
      coalesce(sp.lead_time_days, s.lead_time_days, 7) lead_time_days
    from public.supplier_products sp
    join public.suppliers s on s.id = sp.supplier_id
    where sp.tenant_id = p_tenant_id and s.is_active
    order by sp.variant_id, sp.is_primary desc, sp.created_at asc
  ), inbound as (
    select pol.variant_id, po.store_id,
      sum(greatest(0, pol.quantity_ordered - pol.quantity_received)) on_order
    from public.purchase_order_lines pol
    join public.purchase_orders po on po.id = pol.purchase_order_id
    where pol.tenant_id = p_tenant_id
      and po.store_id = (select rs.store_id from run_scope rs)
      and po.status in ('sent', 'partial')
    group by pol.variant_id, po.store_id
  ), fallback_supplier as (
    select s.id supplier_id, s.name supplier_name, s.lead_time_days
    from public.suppliers s
    where s.tenant_id = p_tenant_id and s.is_active
    order by s.name
    limit 1
  )
  select v.variant_id, v.store_id,
         coalesce(ps.supplier_id, fs.supplier_id),
         coalesce(ps.supplier_name, fs.supplier_name),
         coalesce(ps.lead_time_days, fs.lead_time_days, 7), 7,
         coalesce(vsl.quantity, 0), coalesce(i.on_order, 0)
  from variants v
  left join primary_supplier ps on ps.variant_id = v.variant_id
  left join fallback_supplier fs on true
  left join public.variant_stock_levels vsl
    on vsl.tenant_id = p_tenant_id
   and vsl.variant_id = v.variant_id
   and vsl.store_id = v.store_id
  left join inbound i on i.variant_id = v.variant_id and i.store_id = v.store_id;
end;
$$;

revoke execute on function public.ml_forecast_run_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ml_forecast_run_context(uuid, uuid)
  to ml_forecast;

commit;
