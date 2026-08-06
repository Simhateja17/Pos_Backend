-- 0037 — counter pairing, local PIN staff, and cashier session history.
--
-- A terminal is the store's logical counter. A browser/device is paired to
-- one terminal at a time, but the pairing can be replaced by an owner or
-- manager when the device is swapped or fails.

ALTER TABLE public.terminals
  ADD COLUMN IF NOT EXISTS cash_mode text NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS device_token_hash text,
  ADD COLUMN IF NOT EXISTS device_paired_at timestamptz,
  ADD COLUMN IF NOT EXISTS device_last_seen_at timestamptz;

ALTER TABLE public.terminals
  DROP CONSTRAINT IF EXISTS terminals_cash_mode_check;

ALTER TABLE public.terminals
  ADD CONSTRAINT terminals_cash_mode_check CHECK (cash_mode IN ('cash', 'none'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_terminals_device_token_hash
  ON public.terminals (device_token_hash)
  WHERE device_token_hash IS NOT NULL;

ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS pin_must_change boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff_members(id) ON DELETE RESTRICT,
  terminal_id uuid REFERENCES public.terminals(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  logged_in_at timestamptz NOT NULL DEFAULT now(),
  logged_out_at timestamptz,
  logout_reason text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_sessions_logout_reason_check CHECK (
    logout_reason IS NULL OR logout_reason IN ('explicit', 'idle', 'interrupted', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS idx_staff_sessions_tenant_logged_in
  ON public.staff_sessions (tenant_id, logged_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff_logged_in
  ON public.staff_sessions (staff_id, logged_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_sessions_terminal_active
  ON public.staff_sessions (terminal_id)
  WHERE logged_out_at IS NULL;

ALTER TABLE public.staff_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_staff_sessions ON public.staff_sessions
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_sessions TO app_runtime;

-- Deactivated accounts must not receive fresh owner/manager/cashier claims.
-- Existing JWTs still expire/refresh normally; operator tokens are checked
-- against the active staff/session rows by the API middleware.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims jsonb;
  staff_role text;
  staff_tenant_id uuid;
BEGIN
  SELECT role, tenant_id INTO staff_role, staff_tenant_id
  FROM public.staff_members
  WHERE user_id = (event->>'user_id')::uuid
    AND is_active = true
  LIMIT 1;

  claims := event->'claims';
  claims := jsonb_set(claims, '{role}', coalesce(to_jsonb(staff_role), 'null'));
  claims := jsonb_set(claims, '{tenant_id}', coalesce(to_jsonb(staff_tenant_id), 'null'));

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;
