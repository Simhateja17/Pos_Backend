-- 0060 — preserve the distinction between bill allocation and physical cash
-- tendered so checkout can calculate change without corrupting payment sums.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cash_received numeric(12,2),
  ADD COLUMN IF NOT EXISTS change_due numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.sales
  DROP CONSTRAINT IF EXISTS sales_cash_change_check;

ALTER TABLE public.sales
  ADD CONSTRAINT sales_cash_change_check CHECK (
    change_due >= 0
    AND (cash_received IS NULL OR cash_received >= change_due)
  );
