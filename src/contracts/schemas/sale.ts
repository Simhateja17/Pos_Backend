import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { PaymentInputSchema, PaymentSchema } from './payment'

extendZodWithOpenApi(z)

// Mutually exclusive discount forms — request accepts either, persisted row
// always ends up with a concrete computed dollar amount (RESEARCH.md Open
// Question #2's resolution).
export const SaleLineInputSchema = z
  .object({
    variantId: z.string().uuid(),
    quantity: z.number().int().positive(),
    discountPercent: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).optional(),
    discountAmount: z.string().regex(/^\d+\.\d{2}$/).optional(),
  })
  .refine((l) => !(l.discountPercent && l.discountAmount), {
    message: 'Provide discountPercent or discountAmount, not both',
    path: ['discountAmount'],
  })

export const CreateSaleSchema = z
  .object({
    clientSaleId: z.string().uuid(),
    shiftId: z.string().uuid(),
    lines: z.array(SaleLineInputSchema).min(1),
    cartDiscountPercent: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/).optional(),
    cartDiscountAmount: z.string().regex(/^\d+\.\d{2}$/).optional(),
    payments: z.array(PaymentInputSchema).min(1),
    customer: z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().max(200).optional(),
        phone: z.string().max(20).optional(),
        email: z.string().email().max(200).optional(),
      })
      .optional(),
    // CHECK-06: optional explicit email target for the fire-and-forget receipt
    // send at charge time, sourced from the checkout UI's "Email receipt"
    // action — independent of `customer.email` (a walk-in sale can still
    // request a one-off receipt email without creating/matching a customer
    // profile field for it).
    receiptEmail: z.string().email().optional(),
  })
  .refine((data) => !(data.cartDiscountPercent && data.cartDiscountAmount), {
    message: 'Provide cartDiscountPercent or cartDiscountAmount, not both',
    path: ['cartDiscountAmount'],
  })
  .openapi('CreateSaleRequest')

export const SaleLineItemSchema = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid(),
    quantity: z.number().int(),
    unitPrice: z.string(),
    discountPercent: z.string().nullable(),
    discountAmount: z.string(),
    isTaxable: z.boolean(),
    lineTotal: z.string(),
  })
  .openapi('SaleLineItem')

// SaleSchema.payments is REQUIRED, not optional — every sale has at least one
// payment row (checkout enforces payments.min(1)) and every read path
// (GET /sales, GET /sales/:id) must populate it, since the returns page (D-10)
// reads sale.payments to render "Refunded to the original payment method: {method}."
// This array also carries direction:'refund' rows once a return is processed.
export const SaleSchema = z
  .object({
    id: z.string().uuid(),
    clientSaleId: z.string().uuid(),
    shiftId: z.string().uuid().nullable(),
    customerId: z.string().uuid().nullable(),
    subtotal: z.string(),
    discountAmount: z.string(),
    taxAmount: z.string(),
    totalAmount: z.string(),
    status: z.string(),
    createdBy: z.string().uuid().nullable(),
    createdAt: z.string(),
    lines: z.array(SaleLineItemSchema),
    payments: z.array(PaymentSchema),
    // Populated on the POST /sales success response only (the tenant row is
    // already loaded there) so the receipt component (03-07) can render the
    // real store name without a second client-side fetch or a fabricated
    // placeholder. Optional/nullable on GET /sales, /sales/:id since those
    // paths don't currently load the tenant row.
    businessName: z.string().nullable().optional(),
  })
  .openapi('Sale')

export const SaleListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.string().trim().max(50).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to), {
    message: 'from must be before to',
    path: ['from'],
  })
  .openapi('SaleListQuery')

export const SaleListSchema = z
  .object({
    items: z.array(SaleSchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
  })
  .openapi('SaleList')

// CHECK-06: real resend-receipt request/response contract. `email` is
// optional — when omitted, the resend endpoint resolves the sale's own
// on-file customer email instead (never a client-guessed cross-tenant
// address, per T-03-19).
export const ResendReceiptInputSchema = z
  .object({
    email: z.string().email().optional(),
  })
  .openapi('ResendReceiptRequest')

export const ResendReceiptResponseSchema = z
  .object({
    ok: z.boolean(),
    email: z.string().email(),
  })
  .openapi('ResendReceiptResponse')

export type CreateSaleInput = z.infer<typeof CreateSaleSchema>
export type Sale = z.infer<typeof SaleSchema>
export type ResendReceiptInput = z.infer<typeof ResendReceiptInputSchema>
export type ResendReceiptResponse = z.infer<typeof ResendReceiptResponseSchema>
