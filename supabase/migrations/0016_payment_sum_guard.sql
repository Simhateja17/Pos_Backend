-- PAY-02 defense-in-depth (RESEARCH.md Pattern 3 / Don't Hand-Roll): mirrors
-- migration 0009's guard-then-raise shape. DEFERRABLE INITIALLY DEFERRED means
-- this fires once per inserted payment row but the check itself only runs at
-- transaction COMMIT, by which point every payment row for the sale (inserted
-- in the same forTenantTransaction loop) already exists -- so every firing
-- sees the final, correct sum. Only checks direction='payment' rows; refund
-- rows are validated against the returned-line total by the application layer
-- (see returns.ts), not this trigger.
create or replace function public.check_payment_sum() returns trigger as $$
declare
  sale_total numeric(12,2);
  paid_sum numeric(12,2);
begin
  select total_amount into sale_total from public.sales where id = new.sale_id;
  select coalesce(sum(amount), 0) into paid_sum
    from public.payments
    where sale_id = new.sale_id and direction = 'payment';

  if paid_sum <> sale_total then
    raise exception 'Payments for sale % sum to % but sale total is %',
      new.sale_id, paid_sum, sale_total
      using errcode = '23514';
  end if;

  return null;
end;
$$ language plpgsql security definer set search_path = public;

create constraint trigger trg_check_payment_sum
  after insert on public.payments
  deferrable initially deferred
  for each row
  when (new.direction = 'payment')
  execute function public.check_payment_sum();
