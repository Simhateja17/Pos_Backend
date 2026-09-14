-- 0088 — make customer-credit returns reduce the immutable khata balance.
-- Each credit refund is bound to the stable mobile return reference so a
-- retry cannot append a second ledger effect.

alter table public.customer_credit_transactions
  add column if not exists return_reference_id uuid;

create unique index if not exists idx_customer_credit_transactions_credit_refund
  on public.customer_credit_transactions(return_reference_id)
  where type = 'credit_refund' and return_reference_id is not null;

alter table public.customer_credit_transactions
  drop constraint if exists customer_credit_transactions_check2;

alter table public.customer_credit_transactions
  add constraint customer_credit_transactions_sale_reference_check
  check (
    (type = 'credit_sale' and sale_id is not null and return_reference_id is null) or
    (type = 'credit_refund' and sale_id is not null and return_reference_id is not null) or
    (type = 'repayment' and sale_id is null and return_reference_id is null)
  );

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
  credit_refund_total numeric(12, 2);
  recorded_credit_refunds numeric(12, 2);
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

  if new.type in ('credit_sale', 'credit_refund') then
    select s.customer_id, s.store_id
      into sale_customer_id, sale_store_id
      from public.sales s
     where s.id = new.sale_id and s.tenant_id = new.tenant_id;

    if sale_customer_id is null or sale_customer_id <> new.customer_id or sale_store_id <> new.store_id then
      raise exception 'customer_credit_transaction_sale_mismatch';
    end if;
  end if;

  if new.type = 'credit_sale' then
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

  if new.type = 'credit_refund' then
    select coalesce(sum(p.amount), 0)
      into credit_refund_total
      from public.payments p
     where p.sale_id = new.sale_id
       and p.tenant_id = new.tenant_id
       and p.method = 'credit'
       and p.direction = 'refund';

    select coalesce(sum(cct.amount), 0)
      into recorded_credit_refunds
      from public.customer_credit_transactions cct
     where cct.sale_id = new.sale_id
       and cct.tenant_id = new.tenant_id
       and cct.type = 'credit_refund';

    if recorded_credit_refunds + new.amount > credit_refund_total then
      raise exception 'customer_credit_transaction_refund_payment_mismatch';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.validate_customer_credit_transaction() from anon, authenticated, public;
