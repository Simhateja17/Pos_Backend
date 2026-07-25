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
function confidenceFor(historyDays: number): 'low' | 'medium' | 'high' {
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
    confidence: confidenceFor(historyDays),
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

export async function generateReorderSuggestions(tx: any, tenantId: string): Promise<{
  generatedAt: Date
  suggested: number
  skipped: SkippedVariant[]
}> {
  const generatedAt = new Date()
  const windowStart = new Date(generatedAt)
  windowStart.setDate(windowStart.getDate() - VELOCITY_WINDOW_DAYS)

  const variants = await tx.variants.findMany({ include: { variant_stock_levels: true, products: true } })

  const rollups = await tx.daily_sales_rollup.findMany({ where: { date: { gte: windowStart } } })
  const byVariant = new Map<string, { units: number; returns: number; firstDate: Date; lastDate: Date }>()
  for (const row of rollups) {
    const existing = byVariant.get(row.variant_id)
    if (!existing) {
      byVariant.set(row.variant_id, {
        units: row.units_sold,
        returns: row.returns_units,
        firstDate: row.date,
        lastDate: row.date,
      })
    } else {
      existing.units += row.units_sold
      existing.returns += row.returns_units
      if (row.date < existing.firstDate) existing.firstDate = row.date
      if (row.date > existing.lastDate) existing.lastDate = row.date
    }
  }

  // on_order, per variant, across every order actually placed with a supplier.
  const openOrders = await tx.purchase_orders.findMany({
    where: { status: { in: ['sent', 'partial'] } },
    include: { purchase_order_lines: true, suppliers: true },
  })
  const onOrderByVariant = new Map<string, number>()
  // Most recent supplier to have been ordered from, used to attribute a
  // suggestion (and its lead time) to a real vendor.
  const supplierByVariant = new Map<string, { id: string; name: string; leadTimeDays: number }>()
  for (const po of openOrders) {
    for (const line of po.purchase_order_lines ?? []) {
      const outstanding = Math.max(0, line.quantity_ordered - line.quantity_received)
      onOrderByVariant.set(line.variant_id, (onOrderByVariant.get(line.variant_id) ?? 0) + outstanding)
      if (po.suppliers) {
        supplierByVariant.set(line.variant_id, {
          id: po.suppliers.id,
          name: po.suppliers.name,
          leadTimeDays: po.suppliers.lead_time_days,
        })
      }
    }
  }

  // Fall back to any active supplier's lead time when a variant has never been
  // ordered. Without a lead time there is no reorder point at all.
  const activeSuppliers = await tx.suppliers.findMany({ where: { is_active: true }, orderBy: { name: 'asc' } })
  const fallbackSupplier = activeSuppliers[0]

  await tx.reorder_suggestions.deleteMany({})

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

    const historyDays = sales
      ? Math.min(
          VELOCITY_WINDOW_DAYS,
          Math.floor((generatedAt.getTime() - new Date(sales.firstDate).getTime()) / 86400000) + 1,
        )
      : 0

    const outcome = computeReorder({
      unitsSoldInWindow: sales?.units ?? 0,
      returnsInWindow: sales?.returns ?? 0,
      historyDays,
      currentStock: variant.variant_stock_levels?.quantity ?? 0,
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
