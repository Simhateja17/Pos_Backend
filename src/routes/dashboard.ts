import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { DashboardQuerySchema } from '../contracts/schemas/dashboard'
import { forTenant } from '../db/tenantClient'

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
  const client = forTenant(req.user!.tenantId) as any

  const [sales, openShift, variants, stockLevels] = await Promise.all([
    client.sales.findMany({
      where: { status: 'completed', created_at: { gte: startsAt, lte: now } },
      select: { total_amount: true, created_at: true },
      orderBy: { created_at: 'asc' },
    }),
    client.shifts.findFirst({ where: { closed_at: null }, orderBy: { opened_at: 'desc' } }),
    client.variants.findMany({}),
    client.variant_stock_levels.findMany({}),
  ])

  const stockByVariant = new Map(stockLevels.map((level: any) => [level.variant_id, Number(level.quantity)]))
  const productIds = [...new Set(variants.map((variant: any) => variant.product_id))]
  const products = productIds.length > 0
    ? await client.products.findMany({ where: { id: { in: productIds } } })
    : []
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
      quantity: item.quantity,
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
      grossMargin: { status: 'unavailable', reason: 'Canonical product cost data is not persisted.' },
    },
    cashDrawer: openShift
      ? { status: 'open', shiftId: openShift.id, openingCash: new Prisma.Decimal(openShift.starting_cash).toFixed(2), openedAt: openShift.opened_at.toISOString() }
      : { status: 'no_open_shift' },
    lowStock: { count: lowStock.length, items: lowStock },
    settlement: { status: 'unavailable', reason: 'Settlement status is not persisted.' },
    trend: {
      revenue: [...revenueByDate.entries()].map(([date, amount]) => ({ date, amount: amount.toFixed(2) })),
      profit: { status: 'unavailable', reason: 'Canonical product cost data is not persisted.' },
    },
    actionable: { items: actionable },
  })
})

export default router
