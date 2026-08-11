-- 0055 — server-derived, per-store guided setup and per-staff tour state.
--
-- Readiness is calculated from existing store, staff, catalog, counter and
-- device rows. These tables contain only decisions that cannot be derived.
-- A scanned barcode is intentionally never persisted.

CREATE TABLE IF NOT EXISTS public.store_setup_progress (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  team_mode text,
  scanner_choice text,
  scanner_verified_at timestamptz,
  scanner_variant_id uuid REFERENCES public.variants(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id),
  CONSTRAINT store_setup_team_mode_check
    CHECK (team_mode IS NULL OR team_mode IN ('staffed', 'solo_owner')),
  CONSTRAINT store_setup_scanner_choice_check
    CHECK (scanner_choice IS NULL OR scanner_choice IN ('verified', 'no_scanner', 'configure_later')),
  CONSTRAINT store_setup_verified_fields_check
    CHECK (
      scanner_choice <> 'verified'
      OR (scanner_verified_at IS NOT NULL AND scanner_variant_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_store_setup_progress_store
  ON public.store_setup_progress (store_id);

ALTER TABLE public.store_setup_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_store_setup_progress ON public.store_setup_progress;
CREATE POLICY tenant_isolation_store_setup_progress ON public.store_setup_progress
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_setup_progress TO app_runtime;

CREATE TABLE IF NOT EXISTS public.staff_tour_progress (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff_members(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_started',
  last_step text,
  seen_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz,
  skipped_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id, staff_id),
  CONSTRAINT staff_tour_status_check
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'skipped')),
  CONSTRAINT staff_tour_seen_steps_array_check
    CHECK (jsonb_typeof(seen_steps) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_staff_tour_progress_staff
  ON public.staff_tour_progress (staff_id, updated_at DESC);

ALTER TABLE public.staff_tour_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_staff_tour_progress ON public.staff_tour_progress;
CREATE POLICY tenant_isolation_staff_tour_progress ON public.staff_tour_progress
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_tour_progress TO app_runtime;

CREATE OR REPLACE FUNCTION public.touch_guided_setup_progress() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_guided_setup_progress() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_guided_setup_progress() FROM anon;
REVOKE ALL ON FUNCTION public.touch_guided_setup_progress() FROM authenticated;

DROP TRIGGER IF EXISTS trg_touch_store_setup_progress ON public.store_setup_progress;
CREATE TRIGGER trg_touch_store_setup_progress
  BEFORE UPDATE ON public.store_setup_progress
  FOR EACH ROW EXECUTE FUNCTION public.touch_guided_setup_progress();

DROP TRIGGER IF EXISTS trg_touch_staff_tour_progress ON public.staff_tour_progress;
CREATE TRIGGER trg_touch_staff_tour_progress
  BEFORE UPDATE ON public.staff_tour_progress
  FOR EACH ROW EXECUTE FUNCTION public.touch_guided_setup_progress();
