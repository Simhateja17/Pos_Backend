-- ML-02: least-privilege database boundary for the nightly forecast job.
--
-- The role deliberately cannot inherit app_runtime's broad application
-- privileges. Its complete table-level surface is:
--   daily_sales_rollup  SELECT
--   reorder_suggestions INSERT, UPDATE
--
-- A password is not stored in source control. Provision or rotate it through
-- the deployment secret manager after this migration is applied.

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ml_forecast') then
    create role ml_forecast
      login
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls;
  end if;
end
$$;

grant usage on schema public to ml_forecast;

-- Make the allow-list explicit even if this role existed before the migration.
revoke all privileges on all tables in schema public from ml_forecast;
revoke all privileges on all sequences in schema public from ml_forecast;

grant select on public.daily_sales_rollup to ml_forecast;
grant insert, update on public.reorder_suggestions to ml_forecast;

comment on role ml_forecast is
  'ML-02 nightly batch: SELECT daily_sales_rollup; INSERT/UPDATE reorder_suggestions only. NOBYPASSRLS and NOINHERIT.';

commit;
