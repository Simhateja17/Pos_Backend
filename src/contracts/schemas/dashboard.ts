import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const DashboardRangeSchema = z.enum(['7d', '14d', '30d']).default('7d').openapi('DashboardRange')

export const DashboardQuerySchema = z.object({
  range: DashboardRangeSchema,
}).strict().openapi('DashboardQuery')

const UnavailableMetricSchema = z.object({
  status: z.literal('unavailable'),
  reason: z.string(),
}).openapi('UnavailableDashboardMetric')

/**
 * Gross margin became computable in Phase 5 once goods receipt began
 * persisting a moving-average cost per variant. It stays a union: a tenant
 * whose sold variants have never been received through a purchase order still
 * has no cost basis, and must be told so rather than shown a margin computed
 * against an assumed zero cost (which would report 100% margin).
 *
 * `costedRevenue` / `uncostedRevenue` make the coverage explicit — a margin
 * derived from 60% of revenue is a different claim from one derived from all
 * of it, and the owner is entitled to see which.
 */
const GrossMarginSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    amount: z.string(),
    percent: z.string(),
    costOfGoodsSold: z.string(),
    costedRevenue: z.string(),
    uncostedRevenue: z.string(),
  }),
  UnavailableMetricSchema,
]).openapi('DashboardGrossMargin')

const LowStockItemSchema = z.object({
  variantId: z.string().uuid(),
  productId: z.string().uuid(),
  productName: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  reorderThreshold: z.number().int(),
}).openapi('DashboardLowStockItem')

const ActionableItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('low_stock'),
    variantId: z.string().uuid(),
    productName: z.string(),
    sku: z.string(),
    quantity: z.number().int(),
    reorderThreshold: z.number().int(),
  }),
  z.object({
    type: z.literal('open_shift'),
    shiftId: z.string().uuid(),
    openedAt: z.string().datetime({ offset: true }),
  }),
]).openapi('DashboardActionableItem')

export const DashboardSchema = z.object({
  range: z.enum(['7d', '14d', '30d']),
  period: z.object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  }),
  sales: z.object({
    totalAmount: z.string(),
    billCount: z.number().int().nonnegative(),
    averageBillAmount: z.string(),
    grossMargin: GrossMarginSchema,
  }),
  cashDrawer: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('open'),
      shiftId: z.string().uuid(),
      openingCash: z.string(),
      openedAt: z.string().datetime({ offset: true }),
    }),
    z.object({ status: z.literal('no_open_shift') }),
  ]),
  lowStock: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(LowStockItemSchema),
  }),
  settlement: UnavailableMetricSchema,
  trend: z.object({
    revenue: z.array(z.object({ date: z.string().date(), amount: z.string() })),
    profit: UnavailableMetricSchema,
  }),
  actionable: z.object({ items: z.array(ActionableItemSchema) }),
}).openapi('Dashboard')

export type DashboardQuery = z.infer<typeof DashboardQuerySchema>
