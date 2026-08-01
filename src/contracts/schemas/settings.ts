import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/**
 * Store settings — the tenant fields signup captures once and nothing, until
 * now, could ever edit again.
 *
 * Legal name, trade name, and GST fields deliberately carry no server-side
 * lock. This app is not the authority on those values — the GST portal is.
 * A change here only records what the owner says is true; it does not amend
 * their actual GST registration, which requires Form GST REG-14 on the
 * government portal. See UI copy for the exact warning shown alongside these
 * fields.
 */
export const StoreSettingsSchema = z
  .object({
    businessName: z.string(),
    tradeName: z.string().nullable(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    gstStatus: z.enum(['regular', 'composition', 'unregistered']).nullable(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    placeOfSupply: z.string().nullable(),
    businessType: z
      .enum(['supermarket', 'grocery', 'bakery', 'general', 'apparel', 'electronics', 'other'])
      .nullable(),
    // Reported as one combined rate, matching how checkout and the dashboard
    // already treat state+county+city+district — the owner sets one number,
    // not four jurisdiction-specific ones they'd have to add up themselves.
    combinedTaxRatePercent: z.string(),
    discountThresholdPercent: z.string(),
  })
  .openapi('StoreSettings')

export const UpdateStoreSettingsSchema = z
  .object({
    businessName: z.string().trim().min(1).max(200).optional(),
    tradeName: z.string().trim().max(200).nullable().optional(),
    addressLine1: z.string().trim().min(1).max(250).optional(),
    addressLine2: z.string().trim().max(250).nullable().optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    postalCode: z.string().trim().min(1).max(12).optional(),
    gstStatus: z.enum(['regular', 'composition', 'unregistered']).nullable().optional(),
    gstin: z.string().trim().max(15).nullable().optional(),
    pan: z.string().trim().max(10).nullable().optional(),
    placeOfSupply: z.string().trim().max(100).nullable().optional(),
    // A combined-rate write is spread evenly across the four jurisdiction
    // columns rather than dumping it all into `state` — nothing downstream
    // reads the columns individually today, but an owner correcting one
    // column later should not find three-quarters of their rate sitting
    // somewhere unexpected.
    combinedTaxRatePercent: z.number().min(0).max(100).optional(),
    discountThresholdPercent: z.number().min(0).max(100).optional(),
  })
  .strict()
  .openapi('UpdateStoreSettingsRequest')

export type StoreSettings = z.infer<typeof StoreSettingsSchema>
export type UpdateStoreSettingsInput = z.infer<typeof UpdateStoreSettingsSchema>
