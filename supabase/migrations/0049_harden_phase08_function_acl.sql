-- 0049 — revoke public EXECUTE on Phase 8's SECURITY DEFINER trigger functions.
--
-- Caught by `supabase get_advisors --type security` immediately after 0045/0047/
-- 0048 landed: default_store_id(), check_variant_store_price_tenant() and
-- check_stock_transfer_tenant() were all created with Postgres's default
-- EXECUTE-to-PUBLIC grant, which PostgREST exposes as callable RPC endpoints at
-- /rest/v1/rpc/<name> for the anon and authenticated roles.
--
-- These are trigger functions. They are only ever meant to fire from the
-- triggers that own them, and nothing should be able to invoke them directly.
--
-- This is the same hardening 0040 applied to the earlier SECURITY DEFINER
-- functions; every function created before this phase already carries the
-- restricted ACL (postgres + service_role only). Phase 8's three did not
-- inherit it because CREATE FUNCTION always re-grants to PUBLIC.
--
-- LESSON FOR LATER MIGRATIONS: any new SECURITY DEFINER function in this schema
-- must be followed by these revokes in the same migration. Run get_advisors
-- after adding one.

REVOKE EXECUTE ON FUNCTION public.default_store_id() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_variant_store_price_tenant() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_stock_transfer_tenant() FROM public, anon, authenticated;
