import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const CustomerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    billingName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    gstin: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    stateCode: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Customer')

export const CustomerListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .openapi('CustomerListQuery')

export const CustomerListSchema = z
  .object({
    items: z.array(CustomerSchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
  })
  .openapi('CustomerList')

export const CustomerPurchaseSchema = z
  .object({
    id: z.string().uuid(),
    documentId: z.string().uuid().nullable(),
    documentNumber: z.string().nullable(),
    documentType: z.string().nullable(),
    date: z.string(),
    store: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
      })
      .nullable(),
    total: z.string(),
    status: z.string(),
    paymentMethods: z.array(z.string()),
  })
  .openapi('CustomerPurchase')

export const CustomerPurchaseListSchema = z
  .object({
    items: z.array(CustomerPurchaseSchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
  })
  .openapi('CustomerPurchaseList')

const customerAddressFields = {
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  stateCode: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  country: z.string().trim().max(2).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}

// CUST-01: a fully anonymous walk-in sale is allowed (per UI-SPEC copy contract),
// but if a customer profile IS being created, at least one of phone/email must
// be present so findOrCreateCustomer (lib/customers.ts) has something to dedup on.
export const CreateCustomerInputSchema = z
  .object({
    // `name` is retained for checkout compatibility. Manual profile writes
    // should use billingName, but both fields describe the same customer name.
    name: z.string().trim().max(200).nullable().optional(),
    billingName: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    gstin: z.string().trim().max(15).nullable().optional(),
    ...customerAddressFields,
  })
  .refine((c) => !!c.phone || !!c.email, {
    message: 'At least one of phone or email is required',
    path: ['phone'],
  })
  .openapi('CreateCustomerRequest')

export const UpdateCustomerInputSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    billingName: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    gstin: z.string().trim().max(15).nullable().optional(),
    addressLine1: z.string().trim().max(200).nullable().optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(100).nullable().optional(),
    stateCode: z.string().trim().max(100).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    country: z.string().trim().max(2).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one customer field is required',
  })
  .openapi('UpdateCustomerRequest')

export const CustomerPurchaseListQuerySchema = z
  .object({
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .openapi('CustomerPurchaseListQuery')

export type Customer = z.infer<typeof CustomerSchema>
export type CreateCustomerInput = z.infer<typeof CreateCustomerInputSchema>
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerInputSchema>
