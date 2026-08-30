-- Regional Global Master Item autocomplete plus shop-owned inventory fields.
-- The same migration is applied to India and International databases; seed
-- files are deliberately region-specific and loaded independently.

create table public.master_items (
  id uuid primary key default gen_random_uuid(),
  region text not null check (region in ('IN', 'INTL')),
  canonical_name text not null,
  brand text,
  category text not null,
  subcategory text,
  pack_size numeric(12, 3) check (pack_size is null or pack_size > 0),
  unit text not null check (unit in ('piece', 'kg', 'gram', 'litre', 'ml', 'metre', 'box', 'pack', 'set', 'pair')),
  sell_unit text not null default 'piece' check (sell_unit in ('piece', 'kg', 'gram', 'litre', 'ml', 'metre', 'box', 'pack', 'set', 'pair')),
  barcode text check (barcode is null or barcode ~ '^[0-9]{8,14}$'),
  aliases text[] not null default '{}',
  source text,
  verified_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (region, canonical_name, brand, pack_size, unit)
);

comment on table public.master_items is
  'Ambel-curated regional identity suggestions. Never stores merchant prices, suppliers, stock, expiry, tax rate, or HSN/SAC.';

create index idx_master_items_region_active_name
  on public.master_items (region, is_active, canonical_name);
create index idx_master_items_region_category
  on public.master_items (region, category)
  where is_active;
create index idx_master_items_search_trgm
  on public.master_items using gin (
    (lower(canonical_name || ' ' || coalesce(brand, '') || ' ' || array_to_string(aliases, ' '))) extensions.gin_trgm_ops
  );
create unique index idx_master_items_region_barcode
  on public.master_items (region, barcode)
  where barcode is not null;

alter table public.master_items enable row level security;
create policy master_items_runtime_read on public.master_items
  for select to app_runtime
  using (is_active);
grant select on public.master_items to app_runtime;

alter table public.products
  add column master_item_id uuid references public.master_items(id) on delete set null,
  add column brand text,
  add column description text,
  add column internal_notes text,
  add column is_active boolean not null default true;

create index idx_products_master_item_id on public.products(master_item_id);
create index idx_products_tenant_active_name on public.products(tenant_id, is_active, name);

alter table public.variants
  add column mrp numeric(10, 2) check (mrp is null or mrp >= 0),
  add column list_price numeric(10, 2) check (list_price is null or list_price >= 0),
  add column hsn_sac text check (hsn_sac is null or hsn_sac ~ '^[0-9]{4,8}$'),
  add column purchase_unit text,
  add column purchase_pack_size numeric(12, 3) check (purchase_pack_size is null or purchase_pack_size > 0),
  add column track_inventory boolean not null default true,
  add column allow_negative_stock boolean not null default false,
  add column expiry_date date;

comment on column public.variants.mrp is 'India MRP entered and owned by the merchant; never sourced from master_items.';
comment on column public.variants.list_price is 'Optional International list/compare-at price.';
comment on column public.variants.expiry_date is 'Optional simple expiry for the current/opening stock entry; full lot-level FEFO is a future capability.';

create index idx_variants_tenant_active_inventory
  on public.variants(tenant_id, track_inventory)
  where track_inventory;

-- Keep sale/return movements as an audit trail for non-stock items while
-- preventing those movements from creating meaningless stock balances.
create or replace function public.apply_stock_movement() returns trigger as $$
declare
  resulting_qty numeric(12,3);
  variant_threshold numeric(12,3);
  variant_name text;
  product_name text;
  store_name text;
  should_track boolean;
begin
  select track_inventory into should_track from public.variants where id = new.variant_id;
  if not coalesce(should_track, true) then
    return new;
  end if;

  insert into public.variant_stock_levels (variant_id, store_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.store_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id, store_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now()
  returning quantity into resulting_qty;

  if new.quantity_delta < 0 and new.movement_type <> 'sale' and resulting_qty < 0 then
    raise exception 'Stock movement would take variant % at store % below zero (currently %, delta %)',
      new.variant_id, new.store_id, resulting_qty - new.quantity_delta, new.quantity_delta
      using errcode = '23514';
  end if;

  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  select v.reorder_threshold, v.sku, p.name
    into variant_threshold, variant_name, product_name
  from public.variants v
  join public.products p on p.id = v.product_id
  where v.id = new.variant_id;

  select s.name into store_name from public.stores s where s.id = new.store_id;

  if resulting_qty <= variant_threshold and not exists (
    select 1 from public.notifications
    where tenant_id = new.tenant_id
      and store_id = new.store_id
      and type = 'stock_low'
      and read_at is null
      and metadata->>'variantId' = new.variant_id::text
  ) then
    insert into public.notifications (tenant_id, store_id, type, title, body, link, metadata)
    values (
      new.tenant_id,
      new.store_id,
      'stock_low',
      product_name || ' is low on stock at ' || coalesce(store_name, 'your store'),
      variant_name || ' has ' || resulting_qty || ' left at ' || coalesce(store_name, 'your store')
        || ', at or below its reorder point of ' || variant_threshold || '.',
      '/app/inventory/catalog/' || new.variant_id,
      jsonb_build_object('variantId', new.variant_id, 'storeId', new.store_id)
    );
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
