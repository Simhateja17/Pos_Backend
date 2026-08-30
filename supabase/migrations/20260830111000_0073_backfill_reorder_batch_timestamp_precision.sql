-- 0073 — normalize reorder batches written before migration 0072.
--
-- The trigger added by 0072 protects new and updated rows. Backfill existing
-- rows so the latest forecast becomes readable immediately, without requiring
-- the owner to run the forecast worker again.

begin;

update public.reorder_suggestions
set generated_at = date_trunc('milliseconds', generated_at)
where generated_at is distinct from date_trunc('milliseconds', generated_at);

commit;
