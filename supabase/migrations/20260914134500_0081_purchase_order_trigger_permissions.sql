-- 0081 — the trigger function is internal and must not be callable through Data API roles.

REVOKE ALL ON FUNCTION public.lock_purchase_order_client_authority()
  FROM PUBLIC, anon, authenticated;
