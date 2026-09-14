-- 0084 — stable retry authority for opening a register shift.
-- Existing shifts remain readable; only new keyed mobile requests opt in.

ALTER TABLE public.shifts
  ADD COLUMN client_shift_id uuid,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT shifts_client_request_pair_check CHECK (
    (client_shift_id IS NULL AND request_hash IS NULL)
    OR (client_shift_id IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX uq_shifts_client_opening_operation
  ON public.shifts (tenant_id, store_id, client_shift_id);

CREATE FUNCTION public.lock_shift_client_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.client_shift_id IS DISTINCT FROM NEW.client_shift_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash THEN
    RAISE EXCEPTION 'shift client authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_shift_client_authority() FROM PUBLIC;

CREATE TRIGGER trg_lock_shift_client_authority
BEFORE UPDATE OF client_shift_id, request_hash
ON public.shifts
FOR EACH ROW EXECUTE FUNCTION public.lock_shift_client_authority();
