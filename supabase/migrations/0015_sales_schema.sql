create table public.sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Idempotency seam for Phase 4 (OFFLINE-01) -- no unique constraint yet,
  -- matching 0007's own precedent comment that uniqueness enforcement is
  -- explicitly Phase 4's decision.
  client_sale_id uuid not null,
  shift_id uuid references public.shifts(id),
  customer_id uuid references public.customers(id),
  subtotal numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null,
  total_amount numeric(12,2) not null,
  status text not null default 'completed' check (status in ('completed')),
  created_by uuid references public.staff_members(id),
  created_at timestamptz not null default now()
);

create index idx_sales_tenant_id on public.sales(tenant_id);
create index idx_sales_client_sale_id on public.sales(client_sale_id);
create index idx_sales_customer_id on public.sales(customer_id);
create index idx_sales_shift_id on public.sales(shift_id);

create table public.sale_line_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  discount_percent numeric(5,2),
  discount_amount numeric(10,2) not null default 0,
  is_taxable boolean not null,
  line_total numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create index idx_sale_line_items_sale_id on public.sale_line_items(sale_id);
create index idx_sale_line_items_tenant_id on public.sale_line_items(tenant_id);

create type public.payment_method as enum ('cash', 'card', 'check');
create type public.payment_direction as enum ('payment', 'refund');

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  method public.payment_method not null,
  direction public.payment_direction not null default 'payment',
  amount numeric(12,2) not null check (amount > 0),
  reference_code text,
  created_by uuid references public.staff_members(id),
  created_at timestamptz not null default now(),
  check (method <> 'card' or reference_code is not null)
);

create index idx_payments_sale_id on public.payments(sale_id);
create index idx_payments_tenant_id on public.payments(tenant_id);

alter table public.sales enable row level security;
alter table public.sale_line_items enable row level security;
alter table public.payments enable row level security;

create policy tenant_isolation_sales on public.sales
  for all using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

create policy tenant_isolation_sale_line_items on public.sale_line_items
  for all using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

create policy tenant_isolation_payments on public.payments
  for all using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Append-only per CLAUDE.md ledger discipline: no update/delete grant. A
-- refund is a new payments row with direction='refund', never an edit.
grant select, insert on public.sales, public.sale_line_items, public.payments to app_runtime;
