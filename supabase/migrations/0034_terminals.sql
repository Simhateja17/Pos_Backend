-- 0034 — terminals: a named till/counter within one store.
--
-- Until now a shift was tied only to a staff member, so a store running two
-- counters at once had no way to say which physical drawer a shift belonged
-- to. Two cashiers opening shifts produced two rows that looked identical
-- apart from staff_id, and nothing stopped one person accidentally opening a
-- second shift on a drawer someone else was already running.
--
-- A terminal is a counter inside ONE store, not a second location.
-- Multi-location remains deferred (ROADMAP OPS-01).

CREATE TABLE IF NOT EXISTS public.terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Deactivated rather than deleted: a terminal is referenced by historical
  -- shifts, and those Z reports must keep naming the counter they happened on.
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_terminals_tenant_id ON public.terminals(tenant_id);

-- Same reasoning as categories (0032): case-insensitive uniqueness is what
-- stops "Counter 1" and "counter 1" coexisting as two different tills.
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminals_tenant_name_lower
  ON public.terminals (tenant_id, lower(name));

ALTER TABLE public.terminals ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_terminals ON public.terminals
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.terminals TO app_runtime;

-- Link shifts to the terminal they ran on ------------------------------------

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS terminal_id uuid REFERENCES public.terminals(id);

CREATE INDEX IF NOT EXISTS idx_shifts_terminal_id ON public.shifts(terminal_id);

-- Backfill: every tenant that already has shift history gets a default counter,
-- and its existing shifts are attributed to it. Without this, historical Z
-- reports would show a blank terminal forever.
INSERT INTO public.terminals (tenant_id, name)
SELECT DISTINCT tenant_id, 'Counter 1'
FROM public.shifts
WHERE terminal_id IS NULL
ON CONFLICT DO NOTHING;

UPDATE public.shifts s
SET terminal_id = t.id
FROM public.terminals t
WHERE t.tenant_id = s.tenant_id
  AND lower(t.name) = 'counter 1'
  AND s.terminal_id IS NULL;

-- One terminal = one physical drawer = at most one shift open on it at a time.
-- Enforced in the DB, not just the route handler: two cashiers hitting
-- POST /shifts simultaneously would both pass an application-level check.
-- Partial index, so CLOSED shifts on the same terminal are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_terminal
  ON public.shifts (terminal_id)
  WHERE closed_at IS NULL;
