import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

// Reuses the existing stock_movement_type enum's 'return' value (no new
// Postgres enum needed); mirrors CreateStockMovementSchema's quantityDelta
// non-zero refine via a plain positive-int constraint here.
export const ReturnLineInputSchema = z.object({
  saleLineItemId: z.string().uuid(),
  quantity: z.number().positive(),
})

export const CreateReturnSchema = z
  .object({
    saleId: z.string().uuid(),
    shiftId: z.string().uuid(),
    lines: z.array(ReturnLineInputSchema).min(1),
    refundPayments: z
      .array(
        z.object({
          method: z.enum(['cash', 'card', 'check']),
          amount: z.string().regex(/^\d+\.\d{2}$/),
          referenceCode: z.string().max(50).optional(),
        }),
      )
      .min(1),
  })
  .openapi('CreateReturnRequest')

export type CreateReturnInput = z.infer<typeof CreateReturnSchema>
