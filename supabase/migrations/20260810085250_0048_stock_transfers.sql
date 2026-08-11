-- 0048 — moving stock between shops: send, then confirm.
--
-- Decision: TWO-STEP, not instant. The sender marks goods sent (they leave the
-- source's stock immediately); the destination confirms what actually arrived.
--
-- WHY NOT INSTANT: the product's central claim is accurate stock and no ghost
-- inventory. An instant transfer manufactures ghost inventory in the most
-- ordinary way there is — 5 shirts leave Andheri, 4 arrive at Bandra, and the
-- system insists there are 5 on the shelf until a stock count months later.
-- Send-and-confirm surfaces that gap the same day, with a date and two shops
-- attached to it.
--
-- The discrepancy is the FEATURE. Do not auto-reconcile it, and do not let the
-- receiving screen quietly default the received quantity to the sent quantity —
-- that would reintroduce exactly the ghost stock this design exists to prevent.
--
-- `transfer` was already in the stock_movement_type enum from 0007. The ledger
-- anticipated this; nothing about the append-only model changes.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stock_transfer_status') THEN
    CREATE TYPE public.stock_transfer_status AS ENUM ('sent', 'received', 'cancelled');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.stock_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  from_store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  to_store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  status        public.stock_transfer_status NOT NULL DEFAULT 'sent',
  -- Idempotency, same pattern as sales (0018) and goods receipt (0021): a
  -- retried send must not dispatch the same stock twice.
  client_transfer_id uuid NOT NULL,
  note          text,
  created_by    uuid REFERENCES public.staff_members(id),
  received_by   uuid REFERENCES public.staff_members(id),
  sent_at       timestamptz NOT NULL DEFAULT now(),
  received_at   timestamptz,

  -- Sending stock to the shop it is already in is always a mistake.
  CONSTRAINT stock_transfers_distinct_stores CHECK (from_store_id <> to_store_id),
  -- A received transfer must say when and by whom; an unreceived one must not.
  CONSTRAINT stock_transfers_received_consistency CHECK (
    (status = 'received' AND received_at IS NOT NULL)
    OR (status <> 'received' AND received_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_transfers_client_id
  ON public.stock_transfers (tenant_id, client_transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_store
  ON public.stock_transfers (from_store_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_store
  ON public.stock_transfers (to_store_id, sent_at DESC);
-- Partial index for "what is on its way to me" — the receiving screen's query.
CREATE INDEX IF NOT EXISTS idx_stock_transfers_in_transit
  ON public.stock_transfers (to_store_id)
  WHERE status = 'sent';

CREATE TABLE IF NOT EXISTS public.stock_transfer_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id       uuid NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  variant_id        uuid NOT NULL REFERENCES public.variants(id) ON DELETE RESTRICT,
  quantity_sent     numeric(12,3) NOT NULL,
  -- NULL until the destination confirms. Null is meaningful here: "nobody has
  -- counted this yet" is genuinely different from "zero arrived".
  quantity_received numeric(12,3),

  CONSTRAINT stock_transfer_lines_sent_positive CHECK (quantity_sent > 0),
  -- Deliberately NOT capped at quantity_sent. Receiving more than was sent
  -- means the SEND count was wrong, which is a real thing that happens and
  -- which the owner needs to see, not a violation to reject.
  CONSTRAINT stock_transfer_lines_received_non_negative CHECK (
    quantity_received IS NULL OR quantity_received >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_transfer_lines_unique_variant
  ON public.stock_transfer_lines (transfer_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_tenant
  ON public.stock_transfer_lines (tenant_id);

ALTER TABLE public.stock_transfers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_stock_transfers ON public.stock_transfers
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_stock_transfer_lines ON public.stock_transfer_lines
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON public.stock_transfers      TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.stock_transfer_lines TO app_runtime;

-- Both shops must belong to the same business. Same reasoning as 0047's guard:
-- the RLS predicate keys on the row's own tenant_id, so without this a bad
-- insert could move stock across a tenant boundary and RLS would allow it.
-- This is the one place in the schema where a single row references two stores,
-- so it is the one place that hole could open.
CREATE OR REPLACE FUNCTION public.check_stock_transfer_tenant() RETURNS trigger AS $$
declare
  from_tenant uuid;
  to_tenant uuid;
begin
  select tenant_id into from_tenant from public.stores where id = new.from_store_id;
  select tenant_id into to_tenant   from public.stores where id = new.to_store_id;

  if from_tenant is distinct from new.tenant_id or to_tenant is distinct from new.tenant_id then
    raise exception 'stock_transfers tenant mismatch: row=%, from_store=%, to_store=%',
      new.tenant_id, from_tenant, to_tenant
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

CREATE TRIGGER trg_check_stock_transfer_tenant
  BEFORE INSERT OR UPDATE ON public.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.check_stock_transfer_tenant();

-- NOTE ON THE FLOOR GUARD (0043): a send writes a NEGATIVE movement with
-- movement_type = 'transfer'. That is not the 'sale' carve-out, so the guard
-- applies in full — a shop cannot send stock it does not have. That is the
-- intended behaviour: unlike a sale, where a customer is standing at the till
-- and an honest oversell beats a blocked payment, there is no reason to permit
-- dispatching phantom goods.
