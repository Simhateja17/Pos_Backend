import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { PaymentInputSchema } from './payment'
import { TransactionQuantitySchema } from './product'

extendZodWithOpenApi(z)

// Reuses the existing stock_movement_type enum's 'return' value (no new
// Postgres enum needed); mirrors CreateStockMovementSchema's quantityDelta
// non-zero refine via a plain positive-int constraint here.
export const ReturnLineInputSchema = z.object({
  saleLineItemId: z.string().uuid(),
  quantity: TransactionQuantitySchema,
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
    refundPayments: z.array(PaymentInputSchema).min(1).max(2),
  })
  .refine((data) => new Set(data.refundPayments.map((payment) => payment.method)).size === data.refundPayments.length, {
    message: 'Split refunds must use distinct original tender methods',
    path: ['refundPayments'],
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
  refundPayments: z.array(z.object({
    method: z.string(),
    amount: z.string(),
    referenceCode: z.string().nullable().optional(),
  })).optional(),
    refundTotal: z.string(),
    creditNoteId: z.string().uuid(),
    creditNoteNumber: z.string(),
    idempotent: z.boolean(),
  })
  .openapi('ReturnResponse')

/** Read-only server refund preview. It never allocates a credit-note number,
 * writes stock, or records a payment. */
export const ReturnQuoteRequestSchema = z.object({
  saleId: z.string().uuid(),
  lines: z.array(ReturnLineInputSchema).min(1),
}).strict().openapi('ReturnQuoteRequest')

export const ReturnQuoteSchema = z.object({
  saleId: z.string().uuid(),
  storeId: z.string().uuid(),
  currency: z.string(),
  refundTotal: z.string(),
  lines: z.array(z.object({
    saleLineItemId: z.string().uuid(),
    variantId: z.string().uuid(),
    productName: z.string().nullable(),
    requestedQuantity: z.number(),
    remainingQuantity: z.number(),
    refundAmount: z.string(),
  })),
  originalPayments: z.array(z.object({ method: PaymentInputSchema.shape.method, amount: z.string() })),
}).openapi('ReturnQuote')

export type CreateReturnInput = z.infer<typeof CreateReturnSchema>
