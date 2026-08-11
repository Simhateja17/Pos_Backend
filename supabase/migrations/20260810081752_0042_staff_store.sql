-- 0042 — staff belong to a store.
--
-- Decision: ONE person belongs to ONE store, and their role lives with that
-- store. Priya is the manager at Andheri; she is not simultaneously a cashier
-- at Bandra.
--
-- This is deliberately the simple model. It also removes a trap: had staff
-- belonged to many stores, the natural implementation would embed a store_id
-- array in the access token, and a few hundred UUIDs at 36 bytes each exceeds
-- the practical ~8KB header ceiling — a hard cap on outlet count welded into
-- the auth layer. A single store_id has no such ceiling.
--
-- The owner is the exception: tenant-wide, sees and acts in every store. Their
-- store_id records their home shop for defaulting, and does NOT constrain them.
-- That constraint is enforced in middleware (see storeContext), not here.
--
-- If a customer later genuinely needs one person across two shops, this becomes
-- a join table. Nothing in this migration blocks that.

ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

-- Backfill: every staff member joins their tenant's only store (0041 guarantees
-- exactly one exists per tenant at this point).
UPDATE public.staff_members sm
SET store_id = s.id
FROM public.stores s
WHERE s.tenant_id = sm.tenant_id
  AND sm.store_id IS NULL;

-- Now enforceable. A staff member with no store cannot be scoped, and an
-- unscoped staff member is exactly the hole this phase exists to close.
ALTER TABLE public.staff_members
  ALTER COLUMN store_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_members_store_id ON public.staff_members(store_id);

-- Access token hook ---------------------------------------------------------
--
-- Adds store_id alongside the existing staff_role / tenant_id claims. Replacing
-- the body preserves the ACL hardening applied in 0038/0040 — do not re-grant
-- here, and do not widen the signature.
--
-- The known staleness limitation from 0003 still applies and now extends to
-- store membership: moving a staff member to another shop takes effect on their
-- next token refresh, not instantly. That is acceptable for a move (an
-- administrative act the owner performs deliberately) but is the reason store
-- ACCESS checks are enforced server-side per request in middleware rather than
-- trusted from the claim alone.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  claims jsonb;
  member_role text;
  member_tenant_id uuid;
  member_store_id uuid;
BEGIN
  SELECT role, tenant_id, store_id
    INTO member_role, member_tenant_id, member_store_id
  FROM public.staff_members
  WHERE user_id = (event->>'user_id')::uuid
    AND is_active = true
  LIMIT 1;

  claims := event->'claims';

  IF member_role IS NOT NULL AND member_tenant_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{staff_role}', to_jsonb(member_role), true);
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(member_tenant_id), true);
    claims := jsonb_set(claims, '{store_id}', to_jsonb(member_store_id), true);
  ELSE
    claims := claims - 'staff_role' - 'tenant_id' - 'store_id';
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$function$;
