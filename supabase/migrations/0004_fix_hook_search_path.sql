-- Security hardening: custom_access_token_hook had a mutable search_path
-- (Supabase security advisor: function_search_path_mutable). Pin it explicitly
-- so an attacker-controlled search_path can't hijack unqualified references
-- inside the function body.
alter function public.custom_access_token_hook(jsonb) set search_path = public, pg_temp;
