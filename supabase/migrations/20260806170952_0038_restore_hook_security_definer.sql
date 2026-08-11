-- Regression fix: 0037 redefined public.custom_access_token_hook with a bare
-- CREATE OR REPLACE FUNCTION. In Postgres, CREATE OR REPLACE resets the
-- function's security attribute to the default (SECURITY INVOKER) and clears
-- its per-function config, so that one statement silently reverted BOTH
-- earlier fixes:
--   0004 — the pinned search_path (function_search_path_mutable advisory)
--   0005 — SECURITY DEFINER
--
-- With the hook back on SECURITY INVOKER it executes as supabase_auth_admin,
-- which holds no grant on public.staff_members. Every access-token mint fails
-- with "permission denied for table staff_members (SQLSTATE 42501)", surfacing
-- as HTTP 500 on POST /verify — i.e. no user can complete an OTP login.
--
-- Both attributes are declared inline here, in the same statement as the body,
-- so a future CREATE OR REPLACE of this function cannot drop them by omission.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;
