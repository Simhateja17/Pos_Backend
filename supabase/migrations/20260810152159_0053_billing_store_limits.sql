-- 0053 — a subscription carries how many shops it covers.
--
-- Decision (Phase 8 task 12): charge PER SHOP, never per counter, on a tiered
-- plan with shops included plus an add-on beyond that.
--
-- WHY NOT PER COUNTER: Petpooja advertises "no per-counter charges" as a reason
-- to choose them, so per-till pricing is a known negative in this market. A
-- grocery shop adding a second register must not pay more. terminals stays
-- unlimited and free, deliberately.
--
-- WHY TIERED RATHER THAN LINEAR: the India market does not price multi-outlet
-- linearly. A single shop pays roughly Rs 700/month while a five-outlet chain
-- pays roughly Rs 4,500/month PER OUTLET — about six times more per shop. The
-- market treats multi-outlet as a different, richer product rather than the
-- same product multiplied, and for us it genuinely is: consolidated reporting,
-- transfers, per-shop forecasting and the Stores module do not exist in the
-- single-shop product.
--
-- THE EXACT TIER NUMBERS ARE NOT SETTLED and deliberately do not live here.
-- This migration stores a COUNT AND A LIMIT, which serves any of the pricing
-- models under consideration. Changing what a plan includes is a catalog edit
-- (services/billingCatalog.ts), not a migration.

ALTER TABLE public.billing_subscriptions
  -- How many shops this plan covers before add-ons. Denormalised from the
  -- catalog at subscription time ON PURPOSE: an owner who bought a 3-shop plan
  -- keeps 3 shops even if the catalog later redefines that tier as 2. Repricing
  -- an existing customer by editing a config file is not something that should
  -- be possible by accident.
  ADD COLUMN IF NOT EXISTS included_store_count integer NOT NULL DEFAULT 1,
  -- Shops bought beyond the plan's allowance.
  ADD COLUMN IF NOT EXISTS additional_store_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.billing_subscriptions
  ADD CONSTRAINT billing_subscriptions_included_store_count_positive
    CHECK (included_store_count >= 1),
  ADD CONSTRAINT billing_subscriptions_additional_store_count_non_negative
    CHECK (additional_store_count >= 0);

-- Backfill: every existing subscription covers at least the shops its tenant
-- already has. Nobody is retroactively put over their limit by this migration —
-- an owner discovering they are suddenly non-compliant because we shipped a
-- feature would be indefensible.
--
-- This runs before any UI can create a second shop, so in practice it sets 1
-- everywhere. It is written defensively anyway: if a tenant somehow has more,
-- the subscription is widened to fit rather than the shops being orphaned.
UPDATE public.billing_subscriptions bs
SET included_store_count = greatest(bs.included_store_count, counts.store_count)
FROM (
  SELECT tenant_id, count(*)::integer AS store_count
  FROM public.stores
  WHERE is_active
  GROUP BY tenant_id
) counts
WHERE counts.tenant_id = bs.tenant_id
  AND counts.store_count > bs.included_store_count;

-- NOTE ON NON-PAYMENT: no schema change is needed to lock a delinquent
-- tenant's shops. requireSubscription already gates every operational route on
-- entitlement_status, and that gate is tenant-wide — so an unpaid business
-- loses ALL its shops at once, which is the intended behaviour. Locking a
-- subset would mean choosing which shop stays open, and that is a support
-- nightmare nobody wants to arbitrate.
