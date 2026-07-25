import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const PaymentInputSchema = z
  .object({
    method: z.enum(['cash', 'card', 'check']),
    amount: z.string().regex(/^\d+\.\d{2}$/),
    referenceCode: z.string().max(50).optional(),
  })
  .refine((p) => p.method !== 'card' || !!p.referenceCode, {
    message: 'referenceCode is required for card payments',
    path: ['referenceCode'],
  })
  .openapi('PaymentInput')

export const PaymentSchema = z
  .object({
    id: z.string().uuid(),
    saleId: z.string().uuid(),
    method: z.enum(['cash', 'card', 'check']),
    direction: z.enum(['payment', 'refund']),
    amount: z.string(),
    referenceCode: z.string().nullable(),
    createdBy: z.string().uuid().nullable(),
    createdAt: z.string(),
  })
  .openapi('Payment')

export const PaymentReadQuerySchema = z
  .object({
    method: z.enum(['cash', 'card', 'check']).optional(),
    status: z.enum(['completed', 'refunded']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to), {
    message: 'from must be before to',
    path: ['from'],
  })
  .openapi('PaymentReadQuery')

export const PaymentReadItemSchema = PaymentSchema.extend({
  saleStatus: z.string(),
}).openapi('PaymentReadItem')

export const PaymentReadSchema = z
  .object({
    items: z.array(PaymentReadItemSchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
    summary: z.object({
      collectedAmount: z.string(),
      refundedAmount: z.string(),
      netAmount: z.string(),
    }),
  })
  .openapi('PaymentRead')

export type PaymentInput = z.infer<typeof PaymentInputSchema>
export type Payment = z.infer<typeof PaymentSchema>
