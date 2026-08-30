-- 0075 — India customer credit (khata).
--
-- The ledger is the source of truth for outstanding dues.  There is
-- deliberately no balance column: reads derive balance as credit_sale rows
-- minus repayment rows, so a correction is another immutable row rather than
-- an edit to history.

alter type public.payment_method add value if not exists 'credit';

alter table public.customers
  add column if not exists credit_limit numeric(12, 2);

alter table public.customers
  drop constraint if exists customers_credit_limit_nonnegative;

alter table public.customers
  add constraint customers_credit_limit_nonnegative
  check (credit_limit is null or credit_limit >= 0);

create type public.customer_credit_transaction_type as enum ('credit_sale', 'repayment');

create table public.customer_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  type public.customer_credit_transaction_type not null,
  amount numeric(12, 2) not null,
  sale_id uuid references public.sales(id) on delete restrict,
  recorded_by uuid not null references public.staff_members(id) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  check (amount > 0),
  check (char_length(note) <= 500),
  check (
    (type = 'credit_sale' and sale_id is not null) or
    (type = 'repayment' and sale_id is null)
  )
);

create index idx_customer_credit_transactions_tenant_customer_created
  on public.customer_credit_transactions(tenant_id, customer_id, created_at desc);

create index idx_customer_credit_transactions_tenant_store_created
  on public.customer_credit_transactions(tenant_id, store_id, created_at desc);

create unique index idx_customer_credit_transactions_credit_sale
  on public.customer_credit_transactions(sale_id)
  where type = 'credit_sale' and sale_id is not null;

-- Foreign keys alone do not express the tenant relationship between these
-- tables.  This SECURITY DEFINER trigger closes that gap for every writer,
-- including a future service role, and also guarantees that a credit-sale row
-- is tied to the same customer/store as its sale and to the credit tender that
-- paid that sale.
create or replace function public.validate_customer_credit_transaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sale_customer_id uuid;
  sale_store_id uuid;
  credit_payment_total numeric(12, 2);
begin
  if not exists (
    select 1 from public.customers c
    where c.id = new.customer_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'customer_credit_transaction_customer_tenant_mismatch';
  end if;

  if not exists (
    select 1 from public.stores s
    where s.id = new.store_id and s.tenant_id = new.tenant_id
  ) then
    raise exception 'customer_credit_transaction_store_tenant_mismatch';
  end if;

  if not exists (
    select 1 from public.staff_members sm
    where sm.id = new.recorded_by and sm.tenant_id = new.tenant_id
  ) then
    raise exception 'customer_credit_transaction_staff_tenant_mismatch';
  end if;

  if new.type = 'credit_sale' then
    select s.customer_id, s.store_id
      into sale_customer_id, sale_store_id
      from public.sales s
     where s.id = new.sale_id and s.tenant_id = new.tenant_id;

    if sale_customer_id is null or sale_customer_id <> new.customer_id or sale_store_id <> new.store_id then
      raise exception 'customer_credit_transaction_sale_mismatch';
    end if;

    select coalesce(sum(p.amount), 0)
      into credit_payment_total
      from public.payments p
     where p.sale_id = new.sale_id
       and p.tenant_id = new.tenant_id
       and p.method = 'credit'
       and p.direction = 'payment';

    if credit_payment_total <> new.amount then
      raise exception 'customer_credit_transaction_payment_mismatch';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.validate_customer_credit_transaction() from anon, authenticated, public;

drop trigger if exists customer_credit_transactions_validate on public.customer_credit_transactions;
create trigger customer_credit_transactions_validate
before insert on public.customer_credit_transactions
for each row execute function public.validate_customer_credit_transaction();

alter table public.customer_credit_transactions enable row level security;

create policy tenant_isolation_customer_credit_transactions
  on public.customer_credit_transactions
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only ledger discipline: application_runtime can read and append, but
-- cannot edit or delete historical entries.  Corrections use offsetting rows.
revoke update, delete on public.customer_credit_transactions from public, app_runtime;
grant select, insert on public.customer_credit_transactions to app_runtime;
