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

export type PaymentInput = z.infer<typeof PaymentInputSchema>
export type Payment = z.infer<typeof PaymentSchema>
