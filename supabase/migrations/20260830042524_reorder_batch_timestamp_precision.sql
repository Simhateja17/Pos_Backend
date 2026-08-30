-- 0072 — keep reorder batch timestamps round-trippable through JavaScript.
--
-- PostgreSQL stores timestamptz values with microsecond precision, while a
-- JavaScript Date retains milliseconds only. The suggestions API first reads
-- the newest generated_at and then uses that value to fetch every row in the
-- logical batch. Without normalization, a value such as .588317 is returned to
-- PostgreSQL as .588000 and the exact batch lookup returns no rows.
--
-- Normalize at the table boundary so every current and future writer follows
-- the same precision contract, including the Python forecast worker, the
-- heuristic generator, and database-function fallbacks that use now().

begin;

create or replace function public.normalize_reorder_batch_timestamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  new.generated_at := date_trunc('milliseconds', new.generated_at);
  return new;
end;
$function$;

drop trigger if exists reorder_suggestions_normalize_generated_at
  on public.reorder_suggestions;

create trigger reorder_suggestions_normalize_generated_at
  before insert or update of generated_at on public.reorder_suggestions
  for each row
  execute function public.normalize_reorder_batch_timestamp();

comment on function public.normalize_reorder_batch_timestamp() is
  'Normalizes reorder batch timestamps to JavaScript Date precision so exact batch reads remain lossless.';

commit;
