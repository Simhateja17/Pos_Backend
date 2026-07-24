-- D-04: simple taxable/non-taxable boolean per variant -- no category-threshold
-- exemption rules in V1.
alter table public.variants add column is_taxable boolean not null default true;
