-- Append-only stock ledger (INV-01). Schema supports all 5 movement types per
-- CONTEXT.md, even though this phase's UI only exercises receive/adjustment/transfer
-- (sale/return are written by Phase 3's checkout flow).
create type public.stock_movement_type as enum ('sale', 'receive', 'adjustment', 'return', 'transfer');

-- D-12: fixed reason-code set for manual adjustments, queryable (not free-text-only).
create type public.stock_adjustment_reason as enum ('damage', 'shrinkage_theft', 'count_correction', 'other');

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete restrict,
  movement_type public.stock_movement_type not null,
  -- Signed convention (RESEARCH.md Pattern 3): positive = stock in, negative = stock out.
  quantity_delta integer not null,
  reason_code public.stock_adjustment_reason,
  reason_note text,
  -- Idempotency seam for Phase 3/4's future sale/return writers (OFFLINE-01) — column exists
  -- now so it never needs a retrofit migration onto a populated ledger; uniqueness constraint
  -- is explicitly Phase 4's own decision (RESEARCH.md Assumptions Log A2).
  reference_id uuid,
  created_by uuid references public.staff_members(id),
  created_at timestamptz not null default now(),
  check (quantity_delta <> 0),
  -- D-12: reason_code required for adjustment, forbidden for every other movement type.
  check (
    (movement_type = 'adjustment' and reason_code is not null) or
    (movement_type <> 'adjustment' and reason_code is null)
  ),
  -- D-12: reason_note required specifically when reason_code = 'other'.
  check (reason_code is distinct from 'other' or reason_note is not null)
);

create index idx_stock_movements_tenant_id on public.stock_movements(tenant_id);
create index idx_stock_movements_variant_id on public.stock_movements(variant_id);
create index idx_stock_movements_created_at on public.stock_movements(created_at);

alter table public.stock_movements enable row level security;

create policy tenant_isolation_stock_movements on public.stock_movements
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Append-only enforced at the GRANT level (RESEARCH.md Pattern 1) — deliberately NO
-- update/delete grant. Corrections are new compensating rows, never edits to history.
grant select, insert on public.stock_movements to app_runtime;
