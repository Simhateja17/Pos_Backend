-- 0066 — qualify columns that collide with PL/pgSQL output variables.
--
-- ml_claim_forecast_run returns a tenant_id column. In PL/pgSQL that creates
-- an output variable with the same name as the table column, so an unqualified
-- tenant_id reference fails at runtime before a queued run can be claimed.
-- Keep the repair forward-only and preserve the existing function signatures
-- and ml_forecast grants.

begin;

create or replace function public.ml_claim_forecast_run(p_tenant_id uuid)
returns table (
  run_id uuid,
  tenant_id uuid,
  store_id uuid,
  source public.forecast_run_source,
  requested_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.tenant_id', true), '')::uuid is distinct from p_tenant_id then
    raise exception 'ML run claim tenant does not match RLS context' using errcode = '42501';
  end if;

  update public.forecast_runs fr
     set status = 'failed', completed_at = now(), error_code = 'worker_timeout',
         error_message = 'The forecast worker stopped reporting progress.'
   where fr.tenant_id = p_tenant_id and fr.status = 'running'
     and coalesce(fr.heartbeat_at, fr.started_at, fr.requested_at) < now() - interval '45 minutes';

  return query
  with candidate as (
    select fr.id
    from public.forecast_runs fr
    where fr.tenant_id = p_tenant_id
      and fr.status = 'queued'
    order by fr.requested_at asc
    for update skip locked
    limit 1
  )
  update public.forecast_runs fr
     set status = 'running', started_at = coalesce(fr.started_at, now()),
         heartbeat_at = now(), error_code = null, error_message = null
    from candidate
   where fr.id = candidate.id
  returning fr.id, fr.tenant_id, fr.store_id, fr.source, fr.requested_at;
end;
$$;

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

revoke execute on function public.ml_forecast_variant_context(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ml_forecast_variant_context(uuid, uuid, uuid)
  to ml_forecast;

commit;
