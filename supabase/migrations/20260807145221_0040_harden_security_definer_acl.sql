-- SECURITY-01: SECURITY DEFINER helpers are implementation details, not
-- public RPC endpoints. Keep the auth hook callable only by Supabase Auth and
-- the ML adapters callable only by the isolated forecast role.

begin;

-- Re-assert the final auth hook definition. The live project can contain the
-- 0039 migration already while still missing 0037 in its ledger; applying the
-- missing 0037 migration would otherwise overwrite this hook with its older
-- implementation (which incorrectly writes a JSON null to the reserved
-- Supabase `role` claim).
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

alter function public.touch_billing_updated_at() set search_path = public, pg_temp;

revoke execute on function public.touch_billing_updated_at() from anon, authenticated, public;
revoke execute on function public.apply_purchase_receipt_line() from anon, authenticated, public;
revoke execute on function public.apply_return_to_rollup() from anon, authenticated, public;
revoke execute on function public.apply_sale_line_to_rollup() from anon, authenticated, public;
revoke execute on function public.apply_stock_movement() from anon, authenticated, public;
revoke execute on function public.check_payment_sum() from anon, authenticated, public;
revoke execute on function public.prevent_locked_variant_identity_change() from anon, authenticated, public;

revoke execute on function public.ml_stockout_dates(uuid, uuid, date, date) from anon, authenticated, public;
revoke execute on function public.ml_write_forecast_suggestion(
  uuid, uuid, numeric, numeric, numeric, text, numeric, numeric,
  integer, integer, integer, integer, integer, numeric
) from anon, authenticated, public;

commit;
