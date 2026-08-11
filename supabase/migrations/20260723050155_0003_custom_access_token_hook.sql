create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  staff_role text;
  staff_tenant_id uuid;
begin
  select role, tenant_id into staff_role, staff_tenant_id
  from public.staff_members
  where user_id = (event->>'user_id')::uuid
  limit 1;

  claims := event->'claims';
  claims := jsonb_set(claims, '{role}', coalesce(to_jsonb(staff_role), 'null'));
  claims := jsonb_set(claims, '{tenant_id}', coalesce(to_jsonb(staff_tenant_id), 'null'));

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

-- Required grants per Supabase docs: the auth admin role invokes this hook, and it must be
-- explicitly revoked from public/authenticated to prevent arbitrary invocation.
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;

-- KNOWN LIMITATION (RESEARCH.md Pitfall 4): claims are baked in at token-issuance time.
-- A role change via Settings -> Members does NOT take effect until the affected user's next
-- token refresh (or forced supabase.auth.refreshSession() / re-login). Acceptable for Phase 1
-- per CONTEXT.md Assumption A2 — not re-litigated here.

-- NOTE: this hook resolves claims by `user_id` alone — it does NOT require pin_hash to be set.
-- An invited manager who has completed Supabase's own invite/activation flow (and therefore
-- has a `user_id` linked in staff_members — see plan 01-08's invite route, which sets
-- user_id immediately from the Admin API's inviteUserByEmail response) gets correct
-- role/tenant_id claims on their very first token, even before they've set a PIN.

-- NOTE: Enabling this hook still requires a one-time manual step in the Supabase Dashboard
-- (Authentication -> Hooks -> Custom Access Token -> select this function) — no CLI/API
-- equivalent is exposed as of this research; this is a checkpoint in plan 01-04.
