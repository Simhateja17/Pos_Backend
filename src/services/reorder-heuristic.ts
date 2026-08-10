/**
 * Rule-based reorder suggestions (ML-01, ML-03).
 *
 * This is arithmetic over sales velocity and supplier lead time. It is NOT a
 * forecast and must never be presented as AI — ML-01 is explicit, and the
 * product exists to correct exactly that kind of overclaiming. Phase 6's
 * statsforecast job writes rows with method='forecast' through the same table
 * and the same UI.
 *
 * The formula:
 *
 *   daily_velocity   = net units sold over the trailing window / window days
 *   lead_time_demand = daily_velocity × supplier.lead_time_days
 *   safety_stock     = daily_velocity × SAFETY_DAYS
 *   reorder_point    = lead_time_demand + safety_stock
 *   review_demand    = daily_velocity × REVIEW_PERIOD_DAYS
 *   suggested_qty    = ceil(reorder_point + review_demand − current_stock − on_order)
 *
 * `on_order` is not optional. Telling an owner to order stock that is already
 * in transit is the fastest way to destroy trust in the whole feature.
 */

/** Trailing window for velocity. 30 days balances recency against noise. */
export const VELOCITY_WINDOW_DAYS = 30

/**
 * Below this much history a velocity number is not trustworthy — three days of
 * data can imply an absurd annual run rate. These variants are reported as
 * insufficient-history rather than given a confident number.
 */
export const MIN_HISTORY_DAYS = 14

/** Buffer against demand spikes and late deliveries, in days of cover. */
export const SAFETY_DAYS = 7

/** How often the owner is assumed to review reordering. Ordering less often than this means ordering more each time. */
export const REVIEW_PERIOD_DAYS = 7

export type ReorderReason = {
  formula: 'velocity_x_lead_time'
  /**
   * WHERE the demand numbers came from (Phase 8):
   *   'this_store'   — this shop's own sales history.
   *   'other_stores' — borrowed from the rest of the business and scaled to
   *                    this shop's size, because this shop is too new to have
   *                    a history of its own.
   *
   * The screen must say which. A borrowed number presented as the shop's own
   * is precisely the overclaiming ML-01 forbids.
   */
  basis: 'this_store' | 'other_stores'
  windowDays: number
  /** Days between the variant's first recorded sale and today, capped at windowDays. */
  historyDays: number
  unitsSoldInWindow: number
  returnsInWindow: number
  netUnitsInWindow: number
  dailyVelocity: number
  leadTimeDays: number
  leadTimeDemand: number
  safetyDays: number
  safetyStock: number
  reorderPoint: number
  reviewPeriodDays: number
  reviewPeriodDemand: number
  currentStock: number
  onOrder: number
  /** The raw result before rounding up and flooring at zero. */
  rawSuggestion: number
  supplierName: string | null
}

export type ReorderOutcome =
  | { kind: 'suggest'; quantity: number; confidence: 'low' | 'medium' | 'high'; reason: ReorderReason }
  | { kind: 'insufficient_history'; historyDays: number; reason: ReorderReason }
  | { kind: 'no_velocity'; reason: ReorderReason }
  | { kind: 'sufficient_stock'; reason: ReorderReason }

export type VariantInputs = {
  basis?: 'this_store' | 'other_stores'
  unitsSoldInWindow: number
  returnsInWindow: number
  historyDays: number
  currentStock: number
  onOrder: number
  leadTimeDays: number
  supplierName: string | null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Confidence is a coarse band tied to how much history backs the velocity, not
 * a probability. A heuristic has no basis for claiming a precise number.
 */
function confidenceFor(historyDays: number, basis: 'this_store' | 'other_stores' = 'this_store'): 'low' | 'medium' | 'high' {
  // A borrowed pattern is never better than 'low', however much history the
  // OTHER shops have. The uncertainty being reported is "does this shop behave
  // like the others", and nothing in the data answers that yet.
  if (basis === 'other_stores') return 'low'
  if (historyDays >= 60) return 'high'
  if (historyDays >= 30) return 'medium'
  return 'low'
}

/**
 * Compute one variant's outcome. Pure — every input is passed in, so this is
 * directly testable and the reason it emits is exactly what produced the number.
 */
export function computeReorder(inputs: VariantInputs): ReorderOutcome {
  const {
    basis = 'this_store',
    unitsSoldInWindow,
    returnsInWindow,
    historyDays,
    currentStock,
    onOrder,
    leadTimeDays,
    supplierName,
  } = inputs

  // Returns are subtracted: a unit sold and handed back was never demand.
  const netUnitsInWindow = Math.max(0, unitsSoldInWindow - returnsInWindow)

  // Velocity divides by the observed history, not the full window — a variant
  // first stocked 20 days ago that sold 40 units sells 2/day, not 1.33/day.
  const effectiveDays = Math.max(1, Math.min(historyDays, VELOCITY_WINDOW_DAYS))
  const dailyVelocity = round2(netUnitsInWindow / effectiveDays)

  const leadTimeDemand = round2(dailyVelocity * leadTimeDays)
  const safetyStock = round2(dailyVelocity * SAFETY_DAYS)
  const reorderPoint = round2(leadTimeDemand + safetyStock)
  const reviewPeriodDemand = round2(dailyVelocity * REVIEW_PERIOD_DAYS)
  const rawSuggestion = round2(reorderPoint + reviewPeriodDemand - currentStock - onOrder)

  const reason: ReorderReason = {
    formula: 'velocity_x_lead_time',
    basis,
    windowDays: VELOCITY_WINDOW_DAYS,
    historyDays,
    unitsSoldInWindow,
    returnsInWindow,
    netUnitsInWindow,
    dailyVelocity,
    leadTimeDays,
    leadTimeDemand,
    safetyDays: SAFETY_DAYS,
    safetyStock,
    reorderPoint,
    reviewPeriodDays: REVIEW_PERIOD_DAYS,
    reviewPeriodDemand,
    currentStock,
    onOrder,
    rawSuggestion,
    supplierName,
  }

  // A variant nobody is buying does not get "order 0" — it gets no suggestion
  // at all. Zero is a number; silence is the honest answer.
  if (netUnitsInWindow === 0) return { kind: 'no_velocity', reason }

  // Say so rather than extrapolating an annual run rate from three data points.
  if (historyDays < MIN_HISTORY_DAYS) return { kind: 'insufficient_history', historyDays, reason }

  if (rawSuggestion <= 0) return { kind: 'sufficient_stock', reason }

  return {
    kind: 'suggest',
    quantity: Math.ceil(rawSuggestion),
    confidence: confidenceFor(historyDays, basis),
    reason,
  }
}

/**
 * Generate and persist suggestions for one tenant.
 *
 * Reads `daily_sales_rollup` for velocity, `variant_stock_levels` for current
 * stock, and open purchase orders for on_order. Only 'sent' and 'partial'
 * orders count toward on_order: a draft has not been placed with anyone, so
 * that stock is not actually coming.
 *
 * Previous suggestions for the tenant are cleared first — a stale suggestion
 * computed against last week's stock is worse than none.
 */
export type SkippedVariant = {
  variantId: string
  sku: string
  productName: string
  kind: 'insufficient_history' | 'no_velocity' | 'sufficient_stock' | 'no_supplier'
  historyDays: number | null
}

export async function generateReorderSuggestions(tx: any, tenantId: string, storeId: string): Promise<{
  generatedAt: Date
  suggested: number
  skipped: SkippedVariant[]
}> {
  const generatedAt = new Date()
  const windowStart = new Date(generatedAt)
  windowStart.setDate(windowStart.getDate() - VELOCITY_WINDOW_DAYS)

  // Phase 8: reorder is a PER-SHOP question. Andheri needs Andheri's stock,
  // Andheri's sales history and Andheri's outstanding orders — a suggestion
  // computed from the business's combined numbers would over-order for a small
  // shop and under-order for a busy one.
  const variants = await tx.variants.findMany({
    include: { variant_stock_levels: { where: { store_id: storeId } }, products: true },
  })

  const rollups = await tx.daily_sales_rollup.findMany({
    where: { date: { gte: windowStart }, store_id: storeId },
  })

  // A shop that opened last week has no history of its own, and that is exactly
  // when an owner most needs help deciding what to stock. Rather than showing
  // "not enough data" for two months, borrow the BUSINESS's selling pattern for
  // the same variant and scale it by how busy this shop is relative to the rest.
  //
  // Every borrowed suggestion is labelled `basis: 'other_stores'` so the screen
  // can say where the number came from. An unlabelled borrowed number would be
  // the exact overclaiming this product exists to correct.
  const businessRollups = await tx.daily_sales_rollup.findMany({
    where: { date: { gte: windowStart } },
  })
  const byVariant = new Map<string, { units: number; returns: number; firstDate: Date; lastDate: Date }>()
  for (const row of rollups) {
    const existing = byVariant.get(row.variant_id)
    if (!existing) {
      byVariant.set(row.variant_id, {
        units: Number(row.units_sold),
        returns: Number(row.returns_units),
        firstDate: row.date,
        lastDate: row.date,
      })
    } else {
      existing.units += Number(row.units_sold)
      existing.returns += Number(row.returns_units)
      if (row.date < existing.firstDate) existing.firstDate = row.date
      if (row.date > existing.lastDate) existing.lastDate = row.date
    }
  }

  // Business-wide totals per variant, and this shop's share of overall activity.
  const businessByVariant = new Map<string, { units: number; returns: number; firstDate: Date }>()
  let businessUnits = 0
  let storeUnits = 0
  for (const row of businessRollups) {
    const units = Number(row.units_sold)
    businessUnits += units
    if (row.store_id === storeId) storeUnits += units
    const existing = businessByVariant.get(row.variant_id)
    if (!existing) {
      businessByVariant.set(row.variant_id, {
        units,
        returns: Number(row.returns_units),
        firstDate: row.date,
      })
    } else {
      existing.units += units
      existing.returns += Number(row.returns_units)
      if (row.date < existing.firstDate) existing.firstDate = row.date
    }
  }

  // How busy this shop is relative to the business. A shop with no sales at all
  // yet cannot compute a share, so it is treated as an even split across the
  // shops that do trade — a deliberately conservative starting point rather
  // than assuming the new shop matches the busiest one.
  const otherStoreIds = new Set(
    businessRollups.filter((row: any) => row.store_id !== storeId).map((row: any) => row.store_id),
  )
  const storeShare =
    businessUnits > 0 && storeUnits > 0
      ? storeUnits / businessUnits
      : otherStoreIds.size > 0
        ? 1 / (otherStoreIds.size + 1)
        : 1

  // on_order, per variant, across every order actually placed with a supplier.
  const openOrders = await tx.purchase_orders.findMany({
    // Stock already on its way to THIS shop. Another shop's inbound order does
    // not help this one's shelves, so counting it would under-order here.
    where: { status: { in: ['sent', 'partial'] }, store_id: storeId },
    include: { purchase_order_lines: true },
  })
  const onOrderByVariant = new Map<string, number>()
  for (const po of openOrders) {
    for (const line of po.purchase_order_lines ?? []) {
      const outstanding = Math.max(0, Number(line.quantity_ordered) - Number(line.quantity_received))
      onOrderByVariant.set(line.variant_id, (onOrderByVariant.get(line.variant_id) ?? 0) + outstanding)
    }
  }

  // The variant's own primary supplier link is the real, product-specific
  // lead time (PUR-03) — this replaces "most recent PO's supplier", which
  // could point at a vendor no longer used for this item.
  const primaryLinks = await tx.supplier_products.findMany({
    where: { is_primary: true },
    include: { suppliers: true },
  })
  const supplierByVariant = new Map<string, { id: string; name: string; leadTimeDays: number }>()
  for (const link of primaryLinks) {
    supplierByVariant.set(link.variant_id, {
      id: link.supplier_id,
      name: link.suppliers.name,
      leadTimeDays: link.lead_time_days,
    })
  }

  // Fall back to any active supplier's tenant-wide lead time when a variant
  // has no supplier_products link at all. Without a lead time there is no
  // reorder point at all.
  const activeSuppliers = await tx.suppliers.findMany({ where: { is_active: true }, orderBy: { name: 'asc' } })
  const fallbackSupplier = activeSuppliers[0]

  // Scoped to THIS shop. An unscoped deleteMany would wipe every other shop's
  // suggestions each time one shop regenerated — the owner would open Bandra
  // and find it empty because Andheri ran last.
  await tx.reorder_suggestions.deleteMany({ where: { store_id: storeId } })

  const skipped: SkippedVariant[] = []
  let suggested = 0

  for (const variant of variants) {
    const sales = byVariant.get(variant.id)
    const identity = {
      variantId: variant.id,
      sku: variant.sku,
      productName: variant.products?.name ?? '',
    }
    const supplier = supplierByVariant.get(variant.id) ?? (fallbackSupplier
      ? { id: fallbackSupplier.id, name: fallbackSupplier.name, leadTimeDays: fallbackSupplier.lead_time_days }
      : null)

    if (!supplier) {
      skipped.push({ ...identity, kind: 'no_supplier', historyDays: null })
      continue
    }

    const ownHistoryDays = sales
      ? Math.min(
          VELOCITY_WINDOW_DAYS,
          Math.floor((generatedAt.getTime() - new Date(sales.firstDate).getTime()) / 86400000) + 1,
        )
      : 0

    // Borrow only when this shop genuinely cannot answer for itself AND the
    // rest of the business can. A shop with its own history always uses it,
    // even a short one — its own data beats a scaled guess.
    const business = businessByVariant.get(variant.id)
    const businessHistoryDays = business
      ? Math.min(
          VELOCITY_WINDOW_DAYS,
          Math.floor((generatedAt.getTime() - new Date(business.firstDate).getTime()) / 86400000) + 1,
        )
      : 0
    const borrow =
      ownHistoryDays < MIN_HISTORY_DAYS &&
      businessHistoryDays >= MIN_HISTORY_DAYS &&
      business !== undefined &&
      business.units > 0

    const basis: 'this_store' | 'other_stores' = borrow ? 'other_stores' : 'this_store'
    const historyDays = borrow ? businessHistoryDays : ownHistoryDays

    const outcome = computeReorder({
      basis,
      // Scaled to this shop's size. Handing a new shop the whole business's
      // volume would have it order as if it were every outlet at once.
      unitsSoldInWindow: borrow
        ? Math.round(business!.units * storeShare)
        : sales?.units ?? 0,
      returnsInWindow: borrow
        ? Math.round(business!.returns * storeShare)
        : sales?.returns ?? 0,
      historyDays,
      // variant_stock_levels is one row per (variant, store) since 0043, and
      // the include above is filtered to this shop — so this sums a single
      // row. It stays a reduce rather than `[0]?.quantity` because a variant
      // that has never moved at this shop has no row at all, and 0 is the
      // right answer there.
      currentStock: (variant.variant_stock_levels ?? []).reduce(
        (total: number, level: { quantity: unknown }) => total + Number(level.quantity ?? 0),
        0,
      ),
      onOrder: onOrderByVariant.get(variant.id) ?? 0,
      leadTimeDays: supplier.leadTimeDays,
      supplierName: supplier.name,
    })

    if (outcome.kind !== 'suggest') {
      skipped.push({
        ...identity,
        kind: outcome.kind,
        historyDays: outcome.kind === 'insufficient_history' ? outcome.historyDays : null,
      })
      continue
    }

    await tx.reorder_suggestions.create({
      data: {
        tenant_id: tenantId,
        store_id: storeId,
        variant_id: variant.id,
        supplier_id: supplier.id,
        suggested_quantity: outcome.quantity,
        reason: outcome.reason,
        method: 'heuristic',
        confidence: outcome.confidence,
        generated_at: generatedAt,
      },
    })
    suggested++
  }

  return { generatedAt, suggested, skipped }
}
