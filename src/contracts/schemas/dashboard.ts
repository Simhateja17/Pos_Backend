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
    grossMargin: UnavailableMetricSchema,
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
