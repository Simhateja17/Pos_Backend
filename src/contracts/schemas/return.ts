import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { PaymentInputSchema } from './payment'

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
    // Client-generated idempotency reference. A retry of the same return must
    // carry this exact UUID so the server can return the existing credit note
    // without writing stock or refund rows again.
    returnReferenceId: z.string().uuid(),
    saleId: z.string().uuid(),
    shiftId: z.string().uuid(),
    reason: z.string().trim().min(2).max(500),
    lines: z.array(ReturnLineInputSchema).min(1),
    refundPayments: z.array(PaymentInputSchema).min(1),
  })
  .openapi('CreateReturnRequest')

export const ReturnResponseSchema = z
  .object({
    saleId: z.string().uuid(),
    returnReferenceId: z.string().uuid(),
    refundedLines: z.array(z.object({
      saleLineItemId: z.string().uuid(),
      quantity: z.number(),
      refundAmount: z.string(),
    })).optional(),
    refundTotal: z.string(),
    creditNoteId: z.string().uuid(),
    creditNoteNumber: z.string(),
    idempotent: z.boolean(),
  })
  .openapi('ReturnResponse')

export type CreateReturnInput = z.infer<typeof CreateReturnSchema>
