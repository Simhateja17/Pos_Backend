-- 0067 — claim queued forecast runs across all tenants.
--
-- The manual worker is a shared VM process. It must be able to claim a
-- queued run for any customer, while all subsequent reads/writes continue to
-- use the claimed tenant's RLS context and the existing narrow adapters.

begin;

create or replace function public.ml_claim_next_forecast_run()
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
  -- A VM reboot or killed process must not leave a run stuck forever. This
  -- is intentionally tenant-agnostic because the worker services the
  -- complete queue for this Supabase project.
  update public.forecast_runs fr
     set status = 'failed', completed_at = now(), error_code = 'worker_timeout',
         error_message = 'The forecast worker stopped reporting progress.'
   where fr.status = 'running'
     and coalesce(fr.heartbeat_at, fr.started_at, fr.requested_at)
       < now() - interval '45 minutes';

  return query
  with candidate as (
    select fr.id
    from public.forecast_runs fr
    where fr.status = 'queued'
    order by fr.requested_at asc, fr.id asc
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

revoke execute on function public.ml_claim_next_forecast_run()
  from public, anon, authenticated;
grant execute on function public.ml_claim_next_forecast_run()
  to ml_forecast;

comment on function public.ml_claim_next_forecast_run() is
  'Claims one queued forecast run across tenants for the restricted VM worker. '
  'The worker must set app.tenant_id to the returned tenant before using any '
  'tenant-scoped adapter.';

commit;
