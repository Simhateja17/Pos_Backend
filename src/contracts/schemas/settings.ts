import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/**
 * Symbology used when printing variant labels (0050).
 *
 * - code128 — encodes the owner-assigned `sku`. The default, and the only
 *   option that works for every variant, since every variant has a SKU.
 * - ean13 / upca — encode the MANUFACTURER `barcode`. These are fixed-length
 *   numeric symbologies (13 and 12 digits), so a variant with no barcode, or
 *   one of the wrong length, cannot be rendered in them at all. The label
 *   renderer falls back to CODE128 per-variant rather than printing nothing.
 * - qr — encodes the `sku` as a 2D code, for phone-camera scanning where no
 *   laser scanner is present.
 *
 * The deleted onboarding wizard's fifth option, 'internal', is not carried
 * over: it meant "our own codes", which is what code128 already does.
 */
export const BarcodeLabelFormatSchema = z
  .enum(['code128', 'ean13', 'upca', 'qr'])
  .openapi('BarcodeLabelFormat')

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
    barcodeLabelFormat: BarcodeLabelFormatSchema,
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
    barcodeLabelFormat: BarcodeLabelFormatSchema.optional(),
  })
  .strict()
  .openapi('UpdateStoreSettingsRequest')

export type StoreSettings = z.infer<typeof StoreSettingsSchema>
export type UpdateStoreSettingsInput = z.infer<typeof UpdateStoreSettingsSchema>
