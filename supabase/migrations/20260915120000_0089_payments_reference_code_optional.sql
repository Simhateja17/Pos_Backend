-- Approval code / reference code is optional for all payment methods, including card.
alter table public.payments
  drop constraint if exists payments_check;
