-- Phase 4 / OFFLINE-01 — Task 1: make sale replay safety a database guarantee.
--
-- 0015 created `client_sale_id` as an "idempotency seam" with a NON-unique
-- index, explicitly deferring uniqueness to Phase 4. Until now a retried or
-- redelivered sale could therefore insert a second sale row, with its own
-- payments and its own stock movements — double-booked stock and duplicated
-- tender.
--
-- Enforcement lives in Postgres, not in application code: a check-then-insert
-- in the route races under concurrency (two offline devices draining their
-- queues at the same instant, or a double-click). The unique index is the
-- actual guarantee; the route's conflict handling is ergonomics on top of it.
--
-- Scope is (tenant_id, client_sale_id), not client_sale_id alone. The id is
-- generated client-side, so it is only trustworthy within a tenant.

begin;

-- 1 ---------------------------------------------------------------------------
-- Fail loudly if duplicates already exist. Sales are money: silently deleting
-- or merging a duplicate here could destroy a real second sale that happened to
-- reuse an id. If this raises, resolve the rows by hand before re-running.
do $$
declare
  dupe_count integer;
  sample text;
begin
  select count(*), coalesce(string_agg(t.pair, ', '), '')
    into dupe_count, sample
  from (
    select tenant_id::text || '/' || client_sale_id::text as pair
    from public.sales
    group by tenant_id, client_sale_id
    having count(*) > 1
    limit 10
  ) t;

  if dupe_count > 0 then
    raise exception
      'Cannot add unique index: % duplicate (tenant_id, client_sale_id) group(s) already exist. Sample: %. Resolve these rows manually before applying 0018.',
      dupe_count, sample;
  end if;
end $$;

-- 2 ---------------------------------------------------------------------------
-- Replace the non-unique index from 0015. The unique index serves the same
-- lookup, so keeping both would only cost writes.
drop index if exists public.idx_sales_client_sale_id;

create unique index idx_sales_tenant_client_sale_id
  on public.sales (tenant_id, client_sale_id);

comment on index public.idx_sales_tenant_client_sale_id is
  'OFFLINE-01: guarantees a retried/redelivered sale records exactly once per tenant. POST /sales returns the existing sale on conflict.';

commit;
