-- 0017 — tenant onboarding state (ONBOARD-01 seam, added during Phase 3.2).
--
-- RECOVERED FROM THE DATABASE 2026-07-25. This migration was applied to the
-- Supabase project but its file was never committed, so the repo's migration
-- directory jumped 0016 -> 0018 and any environment rebuilt from source would
-- have been missing these columns entirely. The DDL below is the exact
-- statement recorded in supabase_migrations.schema_migrations for version
-- 20260725051938 — do not "improve" it, or the file and the live schema drift
-- apart again.
--
-- Idempotent (IF NOT EXISTS / COALESCE), so re-running against the live project
-- is a no-op and running it against a fresh database produces the same schema.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS onboarding_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_step smallint NOT NULL DEFAULT 0
    CHECK (onboarding_step BETWEEN 0 AND 8),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz NULL;

UPDATE public.tenants
SET
  onboarding_data = COALESCE(onboarding_data, '{}'::jsonb),
  onboarding_step = COALESCE(onboarding_step, 0)
WHERE onboarding_data IS NULL
   OR onboarding_step IS NULL;
