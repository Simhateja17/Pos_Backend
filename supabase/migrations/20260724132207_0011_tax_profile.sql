-- D-01: jurisdiction-structure rate (not flattened) so a second location/state
-- needs no migration. D-03: combined rate = sum of the 4 columns, applied once
-- per invoice on the post-discount taxable subtotal; tax_rounding_basis is
-- stored explicitly so receipts and future reports always agree (only
-- 'per_invoice' supported in V1, column exists for a future per-line mode
-- without a migration).
alter table public.tenants
  add column tax_rate_state numeric(6,4) not null default 0,
  add column tax_rate_county numeric(6,4) not null default 0,
  add column tax_rate_city numeric(6,4) not null default 0,
  add column tax_rate_district numeric(6,4) not null default 0,
  add column tax_rounding_basis text not null default 'per_invoice'
    check (tax_rounding_basis in ('per_invoice'));
