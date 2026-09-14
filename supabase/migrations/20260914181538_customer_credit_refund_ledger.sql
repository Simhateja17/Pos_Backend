-- PostgreSQL requires a newly added enum label to be committed before a later
-- transaction can use it in constraints, indexes, or function bodies. Keep
-- this enum-only migration immediately before the return ledger migration.
alter type public.customer_credit_transaction_type
  add value if not exists 'credit_refund';
