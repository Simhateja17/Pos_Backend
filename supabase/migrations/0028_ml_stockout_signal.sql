-- ML-02: expose only censored-demand dates to the forecast role.
--
-- The role must not read stock_movements directly. This SECURITY DEFINER
-- function returns only dates on which a tenant-scoped variant's end-of-day
-- ledger balance was exactly zero. It does not expose movement rows, staff,
-- sale references, or customer data.

begin;

create or replace function public.ml_stockout_dates(
  p_tenant_id uuid,
  p_variant_id uuid,
  p_start_date date,
  p_end_date date
)
returns table(stockout_date date)
language plpgsql
security definer
set search_path = public
as $$
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
      and sm.variant_id = p_variant_id
      and (sm.created_at at time zone v_timezone)::date <= d::date
  ), 0) = 0;
end;
$$;

revoke all on function public.ml_stockout_dates(uuid, uuid, date, date) from public;
grant execute on function public.ml_stockout_dates(uuid, uuid, date, date) to ml_forecast;

comment on function public.ml_stockout_dates(uuid, uuid, date, date) is
  'ML-02 censored-demand signal: returns only dates whose end-of-day stock ledger balance is zero; callable by ml_forecast without stock_movements access.';

commit;
