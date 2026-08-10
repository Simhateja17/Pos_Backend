-- 0047 — a shop may override the business price for a variant.
--
-- Decision: ONE shared product list, with an OPTIONAL per-shop price. The same
-- shirt is the same shirt everywhere — splitting the catalog per shop would
-- mean typing every product twice, barcodes that don't match between shops, and
-- reorder history fragmented into useless halves.
--
-- Price is the part that genuinely varies: a mall unit pays more rent than a
-- side-street one and prices accordingly.
--
-- SPARSE BY DESIGN. A row exists only where a shop actually overrides. No row
-- means "use variants.price". The alternative — a row per (variant, shop) with
-- null meaning default — would need maintaining on every product create, every
-- shop create, and would turn a price read into a guaranteed join for the 90%
-- of shops that override nothing.

CREATE TABLE IF NOT EXISTS public.variant_store_prices (
  variant_id uuid NOT NULL REFERENCES public.variants(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  -- tenant_id is redundant against variant/store but is what the RLS policy
  -- keys on, exactly as every other table in this schema does. Deriving it
  -- through a join in the policy would make the predicate non-trivial and
  -- therefore easy to get subtly wrong.
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Mirrors variants.price: numeric(10,2), NOT NULL. A row that exists but
  -- holds null would be a third state meaning nothing.
  price      numeric(10,2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (variant_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_variant_store_prices_store
  ON public.variant_store_prices(store_id);
CREATE INDEX IF NOT EXISTS idx_variant_store_prices_tenant
  ON public.variant_store_prices(tenant_id);

ALTER TABLE public.variant_store_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_variant_store_prices ON public.variant_store_prices
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.variant_store_prices TO app_runtime;

-- A price of zero is almost always a data-entry accident rather than a genuine
-- giveaway, and an accidental zero at the till is unrecoverable revenue.
ALTER TABLE public.variant_store_prices
  ADD CONSTRAINT variant_store_prices_price_positive CHECK (price > 0);

-- Guard the redundant tenant_id against drift: the override must belong to the
-- same business as both the variant and the shop it prices. Without this, a
-- bad insert could point a tenant's price row at another tenant's variant and
-- the RLS predicate above would happily allow it.
CREATE OR REPLACE FUNCTION public.check_variant_store_price_tenant() RETURNS trigger AS $$
declare
  variant_tenant uuid;
  store_tenant uuid;
begin
  select tenant_id into variant_tenant from public.variants where id = new.variant_id;
  select tenant_id into store_tenant  from public.stores   where id = new.store_id;

  if variant_tenant is distinct from new.tenant_id or store_tenant is distinct from new.tenant_id then
    raise exception 'variant_store_prices tenant mismatch: row=%, variant=%, store=%',
      new.tenant_id, variant_tenant, store_tenant
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

CREATE TRIGGER trg_check_variant_store_price_tenant
  BEFORE INSERT OR UPDATE ON public.variant_store_prices
  FOR EACH ROW EXECUTE FUNCTION public.check_variant_store_price_tenant();
