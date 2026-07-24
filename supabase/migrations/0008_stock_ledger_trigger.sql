-- Trigger-derived current stock (INV-02). variant_stock_levels is the ONLY place
-- current stock lives; app code never writes it directly (no update/insert grant
-- for app_runtime — only the SECURITY DEFINER trigger below can write it).
create table public.variant_stock_levels (
  variant_id uuid primary key references public.variants(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  quantity integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.variant_stock_levels enable row level security;

create policy tenant_isolation_variant_stock_levels on public.variant_stock_levels
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select on public.variant_stock_levels to app_runtime;

-- SECURITY DEFINER + explicit search_path: same fix class as
-- 0005_fix_hook_security_definer.sql (RESEARCH.md Pitfall 2) — without this, the
-- trigger runs as app_runtime (SELECT-only on this table) and its own upsert fails.
create or replace function public.apply_stock_movement() returns trigger as $$
begin
  insert into public.variant_stock_levels (variant_id, tenant_id, quantity, updated_at)
  values (new.variant_id, new.tenant_id, new.quantity_delta, now())
  on conflict (variant_id) do update
    set quantity = variant_stock_levels.quantity + new.quantity_delta,
        updated_at = now();

  -- D-04: lock variant identity attributes the first time any movement references it.
  update public.variants set identity_locked = true
    where id = new.variant_id and identity_locked = false;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_apply_stock_movement
  after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- D-04: DB-level guard against TOCTOU bypass of the app's own pre-flight identity-lock
-- check (RESEARCH.md Pitfall 4) — raises if size/color/material change after lock.
create or replace function public.prevent_locked_variant_identity_change() returns trigger as $$
begin
  if old.identity_locked
     and (old.size, old.color, old.material) is distinct from (new.size, new.color, new.material) then
    raise exception 'Variant identity (size/color/material) is locked once stock has moved for this variant'
      using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_prevent_locked_variant_identity_change
  before update on public.variants
  for each row execute function public.prevent_locked_variant_identity_change();
