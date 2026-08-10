import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/**
 * A store is one shop of a business (Phase 8). The tenant is the business and
 * remains the security boundary; a store is a dimension inside it.
 *
 * Tax rates live here rather than on the business because a receipt must record
 * the rate that applied at the shop that made the sale (migration 0046). V1 is
 * same-state only, so today these are identical across a business's shops.
 */
export const StoreSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string(),
    isActive: z.boolean(),
    createdAt: z.string(),
    /** True for the shop the requesting staff member belongs to. */
    isOwnStore: z.boolean(),
    taxRateState: z.string(),
    taxRateCounty: z.string(),
    taxRateCity: z.string(),
    taxRateDistrict: z.string(),
    placeOfSupply: z.string().nullable(),
  })
  .openapi('Store')

const addressFields = {
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  country: z.string().trim().length(2).optional(),
}

// Rates are decimal fractions (0.0825 = 8.25%), matching tenants.tax_rate_* at
// numeric(6,4). Capped at 1 because a rate above 100% is always a units mistake
// — someone typing 8.25 meaning 8.25%.
const taxRate = z.number().min(0).max(1).optional()

export const CreateStoreSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ...addressFields,
    taxRateState: taxRate,
    taxRateCounty: taxRate,
    taxRateCity: taxRate,
    taxRateDistrict: taxRate,
    placeOfSupply: z.string().trim().max(100).optional(),
  })
  .strict()
  .openapi('CreateStoreRequest')

export const UpdateStoreSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    ...addressFields,
    isActive: z.boolean().optional(),
    taxRateState: taxRate,
    taxRateCounty: taxRate,
    taxRateCity: taxRate,
    taxRateDistrict: taxRate,
    placeOfSupply: z.string().trim().max(100).optional(),
  })
  .strict()
  .openapi('UpdateStoreRequest')

export type Store = z.infer<typeof StoreSchema>
export type CreateStoreInput = z.infer<typeof CreateStoreSchema>
export type UpdateStoreInput = z.infer<typeof UpdateStoreSchema>
