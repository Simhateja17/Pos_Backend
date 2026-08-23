-- Damage and shrinkage/theft are stock-loss reasons. Preserve the existing
-- append-only QA evidence, but reject every new row whose direction conflicts
-- with that reason, including writes that bypass the Express API.
alter table public.stock_movements
  add constraint stock_movements_loss_reason_direction_check
  check (
    reason_code not in ('damage', 'shrinkage_theft')
    or quantity_delta < 0
  ) not valid;
