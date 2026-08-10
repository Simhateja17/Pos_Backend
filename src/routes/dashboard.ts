import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { DashboardQuerySchema } from '../contracts/schemas/dashboard'
import { storeScopeWhere } from '../middleware/storeContext'
import { forTenantTransaction } from '../db/tenantClient'

const router = Router()
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000
const RANGE_DAYS = { '7d': 7, '14d': 14, '30d': 30 } as const

function indiaDayBoundary(now: Date, days: number): Date {
  const indiaNow = new Date(now.getTime() + INDIA_OFFSET_MS)
  indiaNow.setUTCHours(0, 0, 0, 0)
  return new Date(indiaNow.getTime() - INDIA_OFFSET_MS - days * 24 * 60 * 60 * 1000)
}

function formatIndiaDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value)
}

function sumAmounts(rows: Array<{ total_amount: Prisma.Decimal | string | number }>): Prisma.Decimal {
  return rows.reduce((total, row) => total.plus(row.total_amount), new Prisma.Decimal(0))
}

/**
 * GET /dashboard — tenant-scoped, bounded dashboard facts. This route does
 * not manufacture comparisons, targets, profit, or settlement outcomes that
 * the persisted Phase 1-3 model cannot prove.
 */
router.get('/', async (req, res) => {
  const parsed = DashboardQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid dashboard range' })

  const now = new Date()
  const startsAt = indiaDayBoundary(now, RANGE_DAYS[parsed.data.range])
  // Phase 8: every fact below is per-shop. Under store scope this narrows to
  // one shop; under an owner's explicit business scope (X-Store-Id: all) the
  // fragment is empty and the dashboard genuinely covers the whole business.
  // Without it, an owner drilled into Andheri would see the business's takings
  // labelled as Andheri's.
  const storeScope = storeScopeWhere(req)
  const { sales, saleLines, openShift, variants, stockLevels, products } = await forTenantTransaction(
    req.user!.tenantId,
    async (tx) => {
      // One short read transaction is materially cheaper than five concurrent
      // transactions against the same tenant. Keep the transaction limited to
      // database reads; all calculations happen after commit below.
      const sales = await tx.sales.findMany({
        where: { status: 'completed', created_at: { gte: startsAt, lte: now }, ...storeScope },
        select: { total_amount: true, created_at: true },
        orderBy: { created_at: 'asc' },
      })
      // Line-level detail is what makes margin computable: cost lives per
      // variant, so revenue has to be attributed per variant too.
      const saleLines = await tx.sale_line_items.findMany({
        // Scoped through the parent sale: a line item belongs to the shop that
        // rang it up, and sale_line_items carries no store_id of its own.
        where: { sales: { status: 'completed', created_at: { gte: startsAt, lte: now }, ...storeScope } },
        select: { variant_id: true, quantity: true, line_total: true },
      })
      const openShift = await tx.shifts.findFirst({ where: { closed_at: null, ...storeScope }, orderBy: { opened_at: 'desc' } })
      const variants = await tx.variants.findMany({})
      const stockLevels = await tx.variant_stock_levels.findMany({ where: { ...storeScope } })
      const productIds = [...new Set(variants.map((variant: any) => variant.product_id))]
      const products = productIds.length > 0
        ? await tx.products.findMany({ where: { id: { in: productIds } } })
        : []
      return { sales, saleLines, openShift, variants, stockLevels, products }
    },
  )

  // Additive, not assignment: under business scope a variant has one row PER
  // SHOP, and the old map shape silently kept only the last one.
  const stockByVariant = new Map<string, number>()
  for (const level of stockLevels as any[]) {
    stockByVariant.set(level.variant_id, (stockByVariant.get(level.variant_id) ?? 0) + Number(level.quantity))
  }
  const productNameById = new Map(products.map((product: any) => [product.id, product.name]))
  const lowStock = variants
    .map((variant: any) => ({ variant, quantity: stockByVariant.get(variant.id) ?? 0 }))
    .filter(({ variant, quantity }: any) => quantity <= variant.reorder_threshold)
    .map(({ variant, quantity }: any) => ({
      variantId: variant.id,
      productId: variant.product_id,
      productName: productNameById.get(variant.product_id) ?? '',
      sku: variant.sku,
      quantity,
      reorderThreshold: variant.reorder_threshold,
    }))

  const totalAmount = sumAmounts(sales)

  /**
   * Gross margin (Phase 5). Cost basis is the per-variant moving average
   * written at goods receipt — see docs/reference/decision-cost-basis.md.
   *
   * Lines whose variant has no cost yet are EXCLUDED from both sides rather
   * than treated as zero-cost, because a zero cost would silently report 100%
   * margin on that revenue. Their revenue is reported separately as
   * uncostedRevenue so the coverage of the figure is visible.
   */
  const costByVariant = new Map<string, Prisma.Decimal>(
    variants
      // Loose != null on purpose: catches both a null column and a variant row
      // selected without the column at all. Either way there is no cost basis.
      .filter((variant: any) => variant.moving_average_cost != null)
      .map((variant: any) => [variant.id, new Prisma.Decimal(variant.moving_average_cost)]),
  )

  let costedRevenue = new Prisma.Decimal(0)
  let uncostedRevenue = new Prisma.Decimal(0)
  let costOfGoodsSold = new Prisma.Decimal(0)
  for (const line of saleLines) {
    const unitCost = costByVariant.get(line.variant_id)
    if (unitCost === undefined) {
      uncostedRevenue = uncostedRevenue.plus(line.line_total)
      continue
    }
    costedRevenue = costedRevenue.plus(line.line_total)
    costOfGoodsSold = costOfGoodsSold.plus(unitCost.times(line.quantity))
  }

  const grossMargin = costedRevenue.isZero()
    ? {
        status: 'unavailable' as const,
        reason:
          saleLines.length === 0
            ? 'No sales in this period.'
            : 'None of the items sold in this period have a recorded cost yet. Receive them against a purchase order to record what they cost.',
      }
    : {
        status: 'available' as const,
        amount: costedRevenue.minus(costOfGoodsSold).toFixed(2),
        percent: costedRevenue.minus(costOfGoodsSold).dividedBy(costedRevenue).times(100).toFixed(1),
        costOfGoodsSold: costOfGoodsSold.toFixed(2),
        costedRevenue: costedRevenue.toFixed(2),
        uncostedRevenue: uncostedRevenue.toFixed(2),
      }
  const revenueByDate = new Map<string, Prisma.Decimal>()
  for (const sale of sales) {
    const date = formatIndiaDate(sale.created_at)
    revenueByDate.set(date, (revenueByDate.get(date) ?? new Prisma.Decimal(0)).plus(sale.total_amount))
  }

  const actionable = [
    ...lowStock.map((item: any) => ({
      type: 'low_stock' as const,
      variantId: item.variantId,
      productName: item.productName,
      sku: item.sku,
      quantity: Number(item.quantity),
      reorderThreshold: item.reorderThreshold,
    })),
    ...(openShift ? [{ type: 'open_shift' as const, shiftId: openShift.id, openedAt: openShift.opened_at.toISOString() }] : []),
  ]

  return res.json({
    range: parsed.data.range,
    period: { startsAt: startsAt.toISOString(), endsAt: now.toISOString() },
    sales: {
      totalAmount: totalAmount.toFixed(2),
      billCount: sales.length,
      averageBillAmount: sales.length === 0 ? '0.00' : totalAmount.dividedBy(sales.length).toFixed(2),
      grossMargin,
    },
    cashDrawer: openShift
      ? { status: 'open', shiftId: openShift.id, openingCash: new Prisma.Decimal(openShift.starting_cash).toFixed(2), openedAt: openShift.opened_at.toISOString() }
      : { status: 'no_open_shift' },
    lowStock: { count: lowStock.length, items: lowStock },
    // PAY2-*: V1 has no payment-gateway integration by design — tender is
    // collected outside the POS and recorded by the cashier — so there is no
    // settlement state to report. This is a permanent V1 answer, not a gap.
    settlement: {
      status: 'unavailable',
      reason: 'Payments are collected on your own card machine or UPI app, so we cannot see when they settle.',
    },
    trend: {
      revenue: [...revenueByDate.entries()].map(([date, amount]) => ({ date, amount: amount.toFixed(2) })),
      // The old reason here claimed no cost data existed. Phase 5 made that
      // false — variants carry a moving-average cost. It is still the wrong
      // input for a historical series: the average is CURRENT, updated on each
      // receipt, so applying it to a sale from three weeks ago would report a
      // profit that never happened. Gross margin for the period is available on
      // the KPI row, where today's cost basis is the right one to use.
      profit: {
        status: 'unavailable',
        reason: 'We record what stock costs you today, which is the wrong figure to apply to past days — so a daily profit line would be misleading.',
      },
    },
    actionable: { items: actionable },
  })
})

export default router
