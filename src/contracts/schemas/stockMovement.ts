import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// extendZodWithOpenApi is internally guarded (no-ops if already applied to this
// z instance) — safe to call again here, same pattern as schemas/product.ts.
extendZodWithOpenApi(z)

export const StockMovementSchema = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid(),
    movementType: z.enum(['sale', 'receive', 'adjustment', 'return', 'transfer']),
    // numeric(12,3) since 0031 — a kg variant moves 2.5, not 2.
    quantityDelta: z.number(),
    reasonCode: z.enum(['damage', 'shrinkage_theft', 'count_correction', 'other']).nullable(),
    reasonNote: z.string().nullable(),
    createdBy: z.string().uuid().nullable(),
    createdAt: z.string(),
  })
  .openapi('StockMovement')

// This phase's UI only exercises receive/adjustment/transfer (sale/return are
// written by Phase 3/4's own checkout/return flows against this same table —
// this endpoint deliberately does not accept those two values yet).
export const CreateStockMovementSchema = z
  .object({
    variantId: z.string().uuid(),
    movementType: z.enum(['receive', 'adjustment', 'transfer']),
    // Whole-vs-fractional is decided by the VARIANT's unit, which this schema
    // cannot see, so the route re-checks it against the loaded variant.
    quantityDelta: z.number().refine((n) => n !== 0, 'quantityDelta must not be zero'),
    reasonCode: z.enum(['damage', 'shrinkage_theft', 'count_correction', 'other']).optional(),
    reasonNote: z.string().max(500).optional(),
  })
  .refine((data) => data.movementType !== 'adjustment' || !!data.reasonCode, {
    message: 'reasonCode is required for adjustment movements',
    path: ['reasonCode'],
  })
  .refine((data) => data.reasonCode !== 'other' || !!data.reasonNote, {
    message: 'reasonNote is required when reasonCode is "other"',
    path: ['reasonNote'],
  })
  .refine(
    (data) => !['damage', 'shrinkage_theft'].includes(data.reasonCode ?? '') || data.quantityDelta < 0,
    {
      message: 'Damage and shrinkage/theft adjustments must decrease stock',
      path: ['quantityDelta'],
    },
  )
  .openapi('CreateStockMovementRequest')

export const LowStockVariantSchema = z
  .object({
    variantId: z.string().uuid(),
    productId: z.string().uuid(),
    productName: z.string(),
    sku: z.string(),
    size: z.string().nullable(),
    color: z.string().nullable(),
    material: z.string().nullable(),
    quantity: z.number(),
    reorderThreshold: z.number(),
    unitOfMeasure: z.string(),
  })
  .openapi('LowStockVariant')

export type StockMovement = z.infer<typeof StockMovementSchema>
export type CreateStockMovementInput = z.infer<typeof CreateStockMovementSchema>
export type LowStockVariant = z.infer<typeof LowStockVariantSchema>
