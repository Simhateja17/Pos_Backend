-- Task 5 (ML-01, ML-03): rule-based reorder suggestions.
--
-- `method` and `confidence` exist from day one even though only 'heuristic' is
-- produced today. Phase 6 fills 'forecast' behind the SAME UI. Adding these
-- columns later would mean a migration plus a UI change plus a backfill of
-- every existing row.
--
-- ML-01 is explicit that this is NOT to be presented as AI. It is a velocity
-- multiplication. The `method` column is what keeps that honest in the data,
-- not just in the copy.

begin;

create type public.reorder_method as enum ('heuristic', 'forecast');

-- Confidence is a coarse, explainable band, not a probability. A heuristic
-- over 18 days of history has no basis for claiming "0.73"; it can honestly
-- say "low". Phase 6's model may map a real interval onto these same bands.
create type public.reorder_confidence as enum ('low', 'medium', 'high');

create table public.reorder_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  suggested_quantity integer not null check (suggested_quantity > 0),
  -- ML-03: the DATA BASIS, structured. Prose assembled in the frontend cannot
  -- be audited. Every input that produced suggested_quantity lives here, so
  -- the number can be recomputed by hand from this column alone.
  reason jsonb not null,
  method public.reorder_method not null default 'heuristic',
  confidence public.reorder_confidence not null,
  generated_at timestamptz not null default now(),
  -- One live suggestion per variant per generation run.
  unique (tenant_id, variant_id, generated_at)
);

create index idx_reorder_suggestions_tenant on public.reorder_suggestions(tenant_id, generated_at desc);
create index idx_reorder_suggestions_variant on public.reorder_suggestions(variant_id);

alter table public.reorder_suggestions enable row level security;

create policy tenant_isolation_reorder_suggestions on public.reorder_suggestions
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, delete on public.reorder_suggestions to app_runtime;

commit;
