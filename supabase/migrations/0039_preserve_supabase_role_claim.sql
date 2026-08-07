-- Supabase's top-level JWT `role` claim is reserved and must remain a valid
-- Postgres role such as "authenticated". The previous hook replaced it with
-- Couture's owner/manager/cashier role and wrote JSON null when a newly-created
-- Auth user did not yet have a staff_members row. Supabase rejects that null
-- before /signup can create the tenant and owner membership.
--
-- Preserve the Supabase role and publish Couture authorization separately as
-- `staff_role`. During the initial signup verification there is intentionally
-- no membership yet, so remove only Couture's optional claims and let Supabase
-- issue the temporary session. /signup creates the membership and refreshes
-- the session, causing this hook to add staff_role and tenant_id.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claims jsonb;
  member_role text;
  member_tenant_id uuid;
BEGIN
  SELECT role, tenant_id INTO member_role, member_tenant_id
  FROM public.staff_members
  WHERE user_id = (event->>'user_id')::uuid
    AND is_active = true
  LIMIT 1;

  claims := event->'claims';

  IF member_role IS NOT NULL AND member_tenant_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{staff_role}', to_jsonb(member_role), true);
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(member_tenant_id), true);
  ELSE
    claims := claims - 'staff_role' - 'tenant_id';
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;
