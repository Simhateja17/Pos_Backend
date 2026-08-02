import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const SupplierProductSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    supplierName: z.string(),
    variantId: z.string().uuid(),
    isPrimary: z.boolean(),
    leadTimeDays: z.number().int().positive(),
    unitCost: z.string().nullable(), // numeric(10,2) — string, same convention as Variant.price
    supplierSku: z.string().nullable(),
    minOrderQty: z.number().int().positive().nullable(),
    createdAt: z.string(),
  })
  .openapi('SupplierProduct')

export const CreateSupplierProductInputSchema = z
  .object({
    supplierId: z.string().uuid(),
    isPrimary: z.boolean().optional(),
    leadTimeDays: z.number().int().positive(),
    unitCost: z.number().nonnegative().optional(),
    supplierSku: z.string().max(100).optional(),
    minOrderQty: z.number().int().positive().optional(),
  })
  .openapi('CreateSupplierProductRequest')

export const UpdateSupplierProductInputSchema = z
  .object({
    isPrimary: z.boolean().optional(),
    leadTimeDays: z.number().int().positive().optional(),
    unitCost: z.number().nonnegative().optional(),
    supplierSku: z.string().max(100).optional(),
    minOrderQty: z.number().int().positive().optional(),
  })
  .openapi('UpdateSupplierProductRequest')

export const SupplierProductListSchema = z.array(SupplierProductSchema).openapi('SupplierProductList')

export type SupplierProduct = z.infer<typeof SupplierProductSchema>
export type CreateSupplierProductInput = z.infer<typeof CreateSupplierProductInputSchema>
export type UpdateSupplierProductInput = z.infer<typeof UpdateSupplierProductInputSchema>
