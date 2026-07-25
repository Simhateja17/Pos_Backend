import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/**
 * ML-03: the data basis, structured. Every field here is an input that
 * produced suggestedQuantity — the UI expands these into the "why" rather
 * than assembling prose the server never saw.
 */
export const ReorderReasonSchema = z
  .object({
    formula: z.string(),
    windowDays: z.number().int(),
    historyDays: z.number().int(),
    unitsSoldInWindow: z.number().int(),
    returnsInWindow: z.number().int(),
    netUnitsInWindow: z.number().int(),
    dailyVelocity: z.number(),
    leadTimeDays: z.number().int(),
    leadTimeDemand: z.number(),
    safetyDays: z.number().int(),
    safetyStock: z.number(),
    reorderPoint: z.number(),
    reviewPeriodDays: z.number().int(),
    reviewPeriodDemand: z.number(),
    currentStock: z.number().int(),
    onOrder: z.number().int(),
    rawSuggestion: z.number(),
    supplierName: z.string().nullable(),
  })
  .openapi('ReorderReason')

export const ReorderSuggestionSchema = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid(),
    sku: z.string(),
    productName: z.string(),
    supplierId: z.string().uuid().nullable(),
    supplierName: z.string().nullable(),
    suggestedQuantity: z.number().int(),
    // 'heuristic' today; Phase 6 writes 'forecast' through the same UI.
    method: z.enum(['heuristic', 'forecast']),
    confidence: z.enum(['low', 'medium', 'high']),
    reason: ReorderReasonSchema,
    generatedAt: z.string(),
  })
  .openapi('ReorderSuggestion')

/**
 * Variants deliberately given no number, and why. Surfacing these is the
 * honest counterpart to the suggestions themselves — an owner should be able
 * to see that a variant was considered and skipped, not silently omitted.
 */
export const ReorderSkippedSchema = z
  .object({
    variantId: z.string().uuid(),
    sku: z.string(),
    productName: z.string(),
    kind: z.enum(['insufficient_history', 'no_velocity', 'sufficient_stock', 'no_supplier']),
    historyDays: z.number().int().nullable(),
  })
  .openapi('ReorderSkipped')

export const ReorderSuggestionListSchema = z
  .object({
    generatedAt: z.string().nullable(),
    items: z.array(ReorderSuggestionSchema),
    skipped: z.array(ReorderSkippedSchema),
  })
  .openapi('ReorderSuggestionList')

export type ReorderSuggestion = z.infer<typeof ReorderSuggestionSchema>
