-- ONBOARD-02 / ONBOARD-03 — historical catalog and sales import.
--
-- Three things this migration exists to guarantee, all in Postgres rather than
-- in route code:
--
-- 1. `sales.source` distinguishes imported history from money that actually
--    moved through this POS. Reports and audits must be able to tell them
--    apart; a migrated tenant's first month otherwise looks like the till rang
--    up 40,000 sales it never saw.
-- 2. `source_metadata` preserves every column the mapping did NOT consume. An
--    owner who loses a column their old system had will not trust the
--    migration, so nothing from the file is discarded — it is carried on the
--    row it came from and stays retrievable.
-- 3. A committed file cannot be committed twice. The guarantee is the unique
--    index below, not a check-then-insert in the route, for the same reason
--    0018 made sale replay a unique index: two concurrent uploads of the same
--    file would both pass a check and both write.

begin;

-- 1 ---------------------------------------------------------------------------
-- Provenance on the sale ledger itself.

alter table public.sales
  add column source text not null default 'pos',
  add column source_metadata jsonb;

alter table public.sales
  add constraint sales_source_check check (source in ('pos', 'import'));

comment on column public.sales.source is
  'ONBOARD-02: ''pos'' for a sale transacted here, ''import'' for migrated history. Reports must not present the two as the same evidence.';
comment on column public.sales.source_metadata is
  'Columns from the imported file that no target field consumed, preserved verbatim so nothing the owner had is lost.';

create index idx_sales_tenant_source on public.sales(tenant_id, source);

-- Catalog rows carry the same preservation guarantee.
alter table public.variants add column source_metadata jsonb;

comment on column public.variants.source_metadata is
  'Unmapped columns from a catalog import, preserved verbatim. See sales.source_metadata.';

-- 2 ---------------------------------------------------------------------------
-- The import batch: one uploaded file, from upload through owner confirmation
-- to commit.

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null,
  file_name text not null,
  -- sha256 of the raw uploaded bytes, before any decoding or parsing, so a
  -- re-upload of the identical file hashes identically regardless of how the
  -- parser happened to interpret it.
  file_hash text not null,
  file_size_bytes integer not null,
  -- The decoded file text is kept so the commit re-parses server-side from the
  -- exact bytes the owner previewed, with no second upload and no trust in
  -- anything the client sends back between review and commit.
  source_text text not null,
  source_columns jsonb not null default '[]'::jsonb,
  row_count integer not null default 0,
  -- Owner-confirmed column mapping. Written only at commit — a suggestion is
  -- never persisted here as though it were a decision (ONBOARD-03).
  mapping jsonb,
  status text not null default 'pending',
  summary jsonb,
  error_message text,
  committed_at timestamptz,
  created_by uuid references public.staff_members(id) on delete set null,
  created_at timestamptz not null default now(),
  check (kind in ('catalog', 'sales')),
  check (status in ('pending', 'committed', 'failed')),
  check (row_count >= 0),
  check (file_size_bytes >= 0)
);

create index idx_import_batches_tenant_created on public.import_batches(tenant_id, created_at desc);

-- Idempotency (Task 4). Partial: only a COMMITTED file claims its hash, so an
-- abandoned preview or a failed attempt never locks the owner out of retrying
-- the same file.
create unique index idx_import_batches_tenant_hash_committed
  on public.import_batches(tenant_id, file_hash)
  where status = 'committed';

comment on index public.idx_import_batches_tenant_hash_committed is
  'ONBOARD-02: re-uploading a file that already committed cannot duplicate history. Enforced here, not in the route.';

alter table public.import_batches enable row level security;

create policy tenant_isolation_import_batches on public.import_batches
  for all
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on public.import_batches to app_runtime;

-- 3 ---------------------------------------------------------------------------
-- Link imported rows back to the batch that produced them, so an import is
-- traceable (and, if it ever must be, reversible by hand).

alter table public.sales
  add column import_batch_id uuid references public.import_batches(id) on delete set null;

create index idx_sales_import_batch on public.sales(import_batch_id)
  where import_batch_id is not null;

commit;
