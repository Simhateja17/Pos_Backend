-- Phase 6 prerequisite — make "one suggestion per variant per day" a real
-- database guarantee.
--
-- 0023 declared `unique (tenant_id, variant_id, generated_at)` on the full
-- timestamptz. That is not the intended key. `generated_at` is set to
-- `now()` by the writer, so two runs on the same day carry different
-- timestamps, the constraint never fires, and the table accumulates duplicate
-- suggestions for the same variant on the same day.
--
-- It has not bitten yet only because the Phase 5 heuristic deletes every row
-- for the tenant before inserting. Phase 6's nightly Python job upserts
-- instead — and a retried or double-scheduled run is exactly the case the key
-- exists to stop. Same discipline as 0018: the guarantee is the index, not a
-- check-then-insert in the job.
--
-- The bucket is the UTC date, not the tenant's business day. This key answers
-- "has tonight's batch already run for this variant", which is a job-scheduling
-- question, not a reporting one. Business-day bucketing belongs in
-- daily_sales_rollup (0022), where it already is, and pulling tenants.timezone
-- into an index expression would not be immutable anyway.

begin;

-- 1 ---------------------------------------------------------------------------
-- Fail loudly if same-day duplicates already exist rather than silently
-- discarding one. There are none today, but a migration that quietly deletes
-- suggestions is not one anyone should trust re-running.
do $$
declare
  dupe_count integer;
begin
  select count(*) into dupe_count from (
    select 1
    from public.reorder_suggestions
    group by tenant_id, variant_id, (generated_at at time zone 'UTC')::date
    having count(*) > 1
  ) t;

  if dupe_count > 0 then
    raise exception
      'Cannot add the daily unique index: % (tenant, variant, day) group(s) already hold more than one suggestion. Resolve these rows by hand before applying 0026.',
      dupe_count;
  end if;
end $$;

-- 2 ---------------------------------------------------------------------------
alter table public.reorder_suggestions
  drop constraint reorder_suggestions_tenant_id_variant_id_generated_at_key;

create unique index idx_reorder_suggestions_tenant_variant_day
  on public.reorder_suggestions (
    tenant_id,
    variant_id,
    ((generated_at at time zone 'UTC')::date)
  );

comment on index public.idx_reorder_suggestions_tenant_variant_day is
  'ML-02: one suggestion per variant per day. A re-run of the nightly batch updates rather than duplicating. Replaces 0023''s constraint on the full timestamptz, which never fired.';

commit;
