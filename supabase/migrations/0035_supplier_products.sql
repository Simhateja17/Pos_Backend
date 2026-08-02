-- PUR-03: per-product supplier links.
--
-- A supplier's lead time and minimum order quantity are properties of what
-- you buy from them, not of the vendor as a whole -- the same mill can ship
-- trims in 3 days and embroidered pieces in 20. `suppliers.lead_time_days`
-- stays as a tenant-wide fallback (used only when a variant has no link
-- row at all), but the real, product-specific numbers live here.
--
-- Fields deliberately excluded: no per-link "unit of measure" or "currency"
-- (single-currency, matches variants.price/unit_cost elsewhere), no
-- `is_active` (a link with no purchase history is just removed, not soft
-- disabled -- unlike suppliers.rows, nothing else references this row by id).

begin;

-- 'address' and 'min_order_value' were collected but never used anywhere in
-- the product: no shipping label or invoice is ever printed, and a single
-- store-wide minimum order value doesn't reflect real vendor terms (which
-- vary per item / case pack). Dropping both rather than leaving unused
-- fields on the vendor card.
alter table public.suppliers drop column address;
alter table public.suppliers drop column min_order_value;

create table public.supplier_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete cascade,
  -- One supplier per variant marked primary -- the reorder heuristic and PO
  -- prefill use this one when a variant has more than one active vendor.
  is_primary boolean not null default false,
  lead_time_days integer not null check (lead_time_days > 0),
  unit_cost numeric(10, 2) check (unit_cost is null or unit_cost >= 0),
  supplier_sku text,
  min_order_qty integer check (min_order_qty is null or min_order_qty > 0),
  created_at timestamptz not null default now(),
  -- One relationship per supplier/variant pair -- re-adding the same pair
  -- edits the existing row instead of creating a duplicate.
  unique (supplier_id, variant_id)
);

create index idx_supplier_products_tenant_id on public.supplier_products(tenant_id);
create index idx_supplier_products_supplier_id on public.supplier_products(supplier_id);
create index idx_supplier_products_variant_id on public.supplier_products(variant_id);

-- At most one primary supplier per variant, enforced in the database rather
-- than trusted to the route -- two concurrent "set as primary" calls must
-- not leave two primaries standing.
create unique index idx_supplier_products_one_primary_per_variant
  on public.supplier_products(variant_id)
  where is_primary;

alter table public.supplier_products enable row level security;

create policy tenant_isolation_supplier_products on public.supplier_products
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on public.supplier_products to app_runtime;

commit;
