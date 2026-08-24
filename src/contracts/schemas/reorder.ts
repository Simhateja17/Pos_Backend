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
    manualForecastEnabled: z.boolean(),
  })
  .openapi('ReorderSuggestionList')

export type ReorderSuggestion = z.infer<typeof ReorderSuggestionSchema>

export const ForecastRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']).openapi('ForecastRunStatus')
export const ForecastRunSourceSchema = z.enum(['manual_test', 'nightly']).openapi('ForecastRunSource')
export const ForecastRunItemDispositionSchema = z
  .enum(['forecast_written', 'heuristic_won', 'ineligible', 'no_supplier', 'sufficient_stock', 'failed'])
  .openapi('ForecastRunItemDisposition')

const ForecastEvidenceSchema = z.record(z.string(), z.unknown()).openapi('ForecastEvidence')

export const ForecastRunSchema = z
  .object({
    id: z.string().uuid(),
    storeId: z.string().uuid(),
    source: ForecastRunSourceSchema,
    status: ForecastRunStatusSchema,
    requestedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    heartbeatAt: z.string().nullable(),
    productsEvaluated: z.number().int(),
    productsEligible: z.number().int(),
    forecastsWon: z.number().int(),
    forecastsWritten: z.number().int(),
    productsSkipped: z.number().int(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    workerVersion: z.string().nullable(),
    modelVersion: z.string().nullable(),
    manualForecastEnabled: z.boolean(),
  })
  .openapi('ForecastRun')

export const ForecastRunItemSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    variantId: z.string().uuid(),
    sku: z.string(),
    productName: z.string(),
    historyDays: z.number().int().nullable(),
    trailingUnits: z.number(),
    totalUnits: z.number(),
    eligible: z.boolean(),
    supplierId: z.string().uuid().nullable(),
    supplierLeadDays: z.number().int().nullable(),
    reviewDays: z.number().int(),
    forecastHorizonDays: z.number().int().nullable(),
    ruleBased: ForecastEvidenceSchema,
    mlResult: ForecastEvidenceSchema,
    disposition: ForecastRunItemDispositionSchema,
    reasonCode: z.string().nullable(),
  })
  .openapi('ForecastRunItem')

export const ForecastRunItemListSchema = z
  .object({
    items: z.array(ForecastRunItemSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('ForecastRunItemList')

export const ForecastRunCreateResponseSchema = z
  .object({
    run: ForecastRunSchema,
    pollAfterMs: z.number().int(),
  })
  .openapi('ForecastRunCreateResponse')

export type ForecastRun = z.infer<typeof ForecastRunSchema>
export type ForecastRunItem = z.infer<typeof ForecastRunItemSchema>
