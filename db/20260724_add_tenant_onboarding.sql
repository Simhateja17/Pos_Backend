-- Phase 03.2: additive tenant-owned onboarding persistence.
--
-- This file is authored and reviewed in Plan 03.2-01. Applying it to the
-- designated non-production database is a separate, blocking Plan 03.2-02
-- action.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS onboarding_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_step smallint NOT NULL DEFAULT 0
    CHECK (onboarding_step BETWEEN 0 AND 8),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz NULL;

-- Explicitly normalize existing rows in case these columns were introduced
-- manually without their defaults before this reviewed migration is applied.
UPDATE public.tenants
SET
  onboarding_data = COALESCE(onboarding_data, '{}'::jsonb),
  onboarding_step = COALESCE(onboarding_step, 0)
WHERE onboarding_data IS NULL
   OR onboarding_step IS NULL;

