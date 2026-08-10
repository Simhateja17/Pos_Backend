import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/**
 * One shop's availability for a variant (Phase 8, task 11).
 *
 * QUANTITY ONLY, DELIBERATELY. This is the one thing a cashier may see about
 * another shop. Their sales, takings, margin and shift figures stay scoped to
 * the shop the person works in — "do they have it in blue" is a customer
 * question; "what did Bandra take today" is not a cashier's business.
 *
 * There is no money field on this schema, and that absence is the contract.
 * Adding one later would silently widen what every cashier can read.
 */
export const StoreAvailabilitySchema = z
  .object({
    storeId: z.string().uuid(),
    storeName: z.string(),
    /** Units on that shop's shelf. Decimal string — stock is numeric(12,3). */
    quantity: z.string(),
    /** True for the shop the requesting staff member belongs to. */
    isOwnStore: z.boolean(),
  })
  .openapi('StoreAvailability')

export const VariantAvailabilitySchema = z
  .object({
    variantId: z.string().uuid(),
    sku: z.string(),
    productName: z.string(),
    /**
     * Active shops only, own shop first, then most stock first. A cashier
     * asking "who has it" wants the fullest shelf, not alphabetical order.
     */
    stores: z.array(StoreAvailabilitySchema),
  })
  .openapi('VariantAvailability')

export type StoreAvailability = z.infer<typeof StoreAvailabilitySchema>
export type VariantAvailability = z.infer<typeof VariantAvailabilitySchema>
