-- The international edition (US, UK, everywhere except India) sells loose
-- goods in US-customary units (pounds, ounces, gallons, ...), not kg/L. The
-- unit enum was metric-only, copied from India's catalog. Widen it to a
-- superset covering both; which subset a catalog screen offers is a
-- frontend region concern (frontend/lib/units.ts), not a DB one — Postgres
-- and the Zod contract (UnitOfMeasureSchema) just need to accept both.

alter table public.variants
  drop constraint if exists variants_unit_of_measure_check;
alter table public.variants
  add constraint variants_unit_of_measure_check check (unit_of_measure in (
    'piece', 'kg', 'gram', 'litre', 'ml', 'metre',
    'lb', 'oz', 'gallon', 'quart', 'pint', 'floz', 'yard', 'foot', 'inch',
    'box', 'pack', 'set', 'pair'
  ));

alter table public.master_items
  drop constraint if exists master_items_unit_check;
alter table public.master_items
  add constraint master_items_unit_check check (unit in (
    'piece', 'kg', 'gram', 'litre', 'ml', 'metre',
    'lb', 'oz', 'gallon', 'quart', 'pint', 'floz', 'yard', 'foot', 'inch',
    'box', 'pack', 'set', 'pair'
  ));

alter table public.master_items
  drop constraint if exists master_items_sell_unit_check;
alter table public.master_items
  add constraint master_items_sell_unit_check check (sell_unit in (
    'piece', 'kg', 'gram', 'litre', 'ml', 'metre',
    'lb', 'oz', 'gallon', 'quart', 'pint', 'floz', 'yard', 'foot', 'inch',
    'box', 'pack', 'set', 'pair'
  ));
