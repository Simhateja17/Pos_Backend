import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const CustomerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Customer')

// CUST-01: a fully anonymous walk-in sale is allowed (per UI-SPEC copy contract),
// but if a customer profile IS being created, at least one of phone/email must
// be present so findOrCreateCustomer (lib/customers.ts) has something to dedup on.
export const CreateCustomerInputSchema = z
  .object({
    name: z.string().max(200).optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email().max(200).optional(),
  })
  .refine((c) => !!c.phone || !!c.email, {
    message: 'At least one of phone or email is required',
    path: ['phone'],
  })
  .openapi('CreateCustomerRequest')

export type Customer = z.infer<typeof CustomerSchema>
export type CreateCustomerInput = z.infer<typeof CreateCustomerInputSchema>
