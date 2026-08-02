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

// Supplier-scoped view (the "Products supplied" tab on a supplier's detail
// page) — same link row, plus enough of the variant/product to render a row
// without a second round trip per item.
export const SupplierProductWithVariantSchema = SupplierProductSchema.extend({
  sku: z.string(),
  productName: z.string(),
  size: z.string().nullable(),
  color: z.string().nullable(),
  material: z.string().nullable(),
}).openapi('SupplierProductWithVariant')

export const SupplierProductWithVariantListSchema = z
  .array(SupplierProductWithVariantSchema)
  .openapi('SupplierProductWithVariantList')

export type SupplierProduct = z.infer<typeof SupplierProductSchema>
export type CreateSupplierProductInput = z.infer<typeof CreateSupplierProductInputSchema>
export type UpdateSupplierProductInput = z.infer<typeof UpdateSupplierProductInputSchema>
export type SupplierProductWithVariant = z.infer<typeof SupplierProductWithVariantSchema>
