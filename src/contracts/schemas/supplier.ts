import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const SupplierSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    contactName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    // Tenant-wide fallback only — used when a variant has no supplier_products
    // link at all. The real, product-specific lead time lives on that link.
    leadTimeDays: z.number().int().positive(),
    paymentTerms: z.string().nullable(),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('Supplier')

// lead_time_days defaults to 7 in the DB but the form always shows and submits
// a value (CLAUDE.md: helper text must explain why it matters), so it is
// required here, not optional-with-default.
export const CreateSupplierInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    contactName: z.string().max(200).optional(),
    email: z.string().email().max(200).optional(),
    phone: z.string().max(20).optional(),
    leadTimeDays: z.number().int().positive(),
    paymentTerms: z.string().max(100).optional(),
  })
  .openapi('CreateSupplierRequest')

export const UpdateSupplierInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    contactName: z.string().max(200).optional(),
    email: z.string().email().max(200).optional(),
    phone: z.string().max(20).optional(),
    leadTimeDays: z.number().int().positive().optional(),
    paymentTerms: z.string().max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .openapi('UpdateSupplierRequest')

export const SupplierListSchema = z.array(SupplierSchema).openapi('SupplierList')

export type Supplier = z.infer<typeof SupplierSchema>
export type CreateSupplierInput = z.infer<typeof CreateSupplierInputSchema>
export type UpdateSupplierInput = z.infer<typeof UpdateSupplierInputSchema>
