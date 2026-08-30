import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// extendZodWithOpenApi is internally guarded (no-ops if already applied to this
// z instance) — safe to call again here, same pattern as contracts/schemas/member.ts.
extendZodWithOpenApi(z)

/**
 * What one unit of a variant IS. `price` is always per ONE of this unit, so a
 * kg variant's price is per-kg and a piece variant's price is per-piece.
 *
 * This is per-VARIANT, not per-product, which is what lets one product carry
 * both forms of the same commodity — loose rice (kg, priced per kg, no
 * barcode) and a pre-packed bag (piece, priced per packet, maker's EAN) are
 * just two ordinary variants.
 */
export const UnitOfMeasureSchema = z
  .enum(['piece', 'kg', 'gram', 'litre', 'ml', 'metre', 'box', 'pack', 'set', 'pair'])
  .openapi('UnitOfMeasure')

/** Units whose quantities may be fractional. A piece/box/pair cannot be sold as 2.5. */
export const FRACTIONAL_UNITS = ['kg', 'gram', 'litre', 'ml', 'metre'] as const

export function allowsFractionalQuantity(unit: z.infer<typeof UnitOfMeasureSchema>): boolean {
  return (FRACTIONAL_UNITS as readonly string[]).includes(unit)
}

// EAN-8/12/13/14 and UPC — externally assigned, digits only. Deliberately NOT
// validated against a check digit: real shelf stock includes in-house and
// regional codes that are structurally valid but not GS1-issued.
const BarcodeSchema = z.string().trim().regex(/^\d{8,14}$/, 'Barcode must be 8-14 digits')

export const VariantSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    sku: z.string(),
    /** Manufacturer-assigned EAN/UPC. Null for own-stock the retailer barcodes itself. */
    barcode: z.string().nullable(),
    unitOfMeasure: UnitOfMeasureSchema,
    size: z.string().nullable(),
    color: z.string().nullable(),
    material: z.string().nullable(),
    price: z.string(), // numeric(10,2) — serialized as a string to avoid float rounding, same convention to use in stockMovement.ts
    mrp: z.string().nullable(),
    listPrice: z.string().nullable(),
    /** Null until the variant has a received/imported cost basis. */
    movingAverageCost: z.string().nullable(),
    hsnSac: z.string().nullable(),
    purchaseUnit: z.string().nullable(),
    purchasePackSize: z.string().nullable(),
    trackInventory: z.boolean(),
    allowNegativeStock: z.boolean(),
    expiryDate: z.string().date().nullable(),
    isTaxable: z.boolean(),
    /** Percentage string for display; null means the legacy store fallback is still active. */
    taxRatePercent: z.string().nullable(),
    // numeric(12,3) since 0031 — a kg variant reorders at 5.5, not 5.
    reorderThreshold: z.number(),
    identityLocked: z.boolean(),
    currentStock: z.number(),
    createdAt: z.string(),
  })
  .openapi('Variant')

export const ProductSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    masterItemId: z.string().uuid().nullable(),
    brand: z.string().nullable(),
    description: z.string().nullable(),
    internalNotes: z.string().nullable(),
    isActive: z.boolean(),
    categoryId: z.string().uuid().nullable(),
    /** Resolved name, so the catalog list needs no second lookup. */
    category: z.string().nullable(),
    createdAt: z.string(),
    variants: z.array(VariantSchema),
  })
  .openapi('Product')

// D-03: sku is optional on input — omit to auto-generate, supply to override.
// Regex restricts to a safe charset (RESEARCH.md Security Domain V5) since this
// string is later encoded directly into a CODE128 barcode and used in URL paths.
export const CreateVariantInputSchema = z
  .object({
    sku: z.string().max(40).regex(/^[A-Za-z0-9-]+$/).optional(),
    /** Scanned/typed manufacturer code. Unique per tenant where present (0031). */
    barcode: BarcodeSchema.optional(),
    unitOfMeasure: UnitOfMeasureSchema.default('piece'),
    size: z.string().max(50).optional(),
    color: z.string().max(50).optional(),
    material: z.string().max(50).optional(),
    price: z.number().nonnegative(),
    /** Mandatory for India tenants; the route enforces the regional rule. */
    mrp: z.number().nonnegative().optional(),
    /** International list/compare-at price. */
    listPrice: z.number().nonnegative().optional(),
    initialCostPrice: z.number().nonnegative().optional(),
    hsnSac: z.string().trim().regex(/^[0-9]{4,8}$/).optional(),
    purchaseUnit: z.string().trim().max(40).optional(),
    purchasePackSize: z.number().positive().optional(),
    trackInventory: z.boolean().default(true),
    allowNegativeStock: z.boolean().default(false),
    expiryDate: z.string().date().optional(),
    /** The GST/VAT rate for this sellable variant, expressed as a percentage. */
    taxRatePercent: z.number().min(0).max(100),
    reorderThreshold: z.number().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    // A discrete unit must stay whole. Enforced here as well as at checkout so
    // a fractional threshold can't be seeded at creation time.
    if (
      value.reorderThreshold !== undefined &&
      !allowsFractionalQuantity(value.unitOfMeasure) &&
      !Number.isInteger(value.reorderThreshold)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `A ${value.unitOfMeasure} variant's reorder point must be a whole number`,
        path: ['reorderThreshold'],
      })
    }
  })

// D-02: at least one variant is required — no product without stock-bearing variants.
export const CreateProductSchema = z
  .object({
    name: z.string().min(1),
    masterItemId: z.string().uuid().optional(),
    brand: z.string().trim().max(120).optional(),
    description: z.string().trim().max(1_000).optional(),
    internalNotes: z.string().trim().max(1_000).optional(),
    /** An existing category. Send categoryName instead to create one inline. */
    categoryId: z.string().uuid().optional(),
    /**
     * A category typed rather than picked. Matched case-insensitively against
     * the tenant's existing categories and created only if genuinely new, so
     * typing "dairy" attaches to "Dairy" instead of forking it.
     */
    categoryName: z.string().trim().max(80).optional(),
    variants: z.array(CreateVariantInputSchema).min(1),
  })
  .openapi('CreateProductRequest')

// Identity fields (size/color/material) are intentionally NOT here — those are
// blocked once identity_locked is true, enforced server-side in the route AND
// by the 0008 migration's DB trigger (defense in depth, RESEARCH.md Pitfall 4).
export const UpdateVariantSchema = z
  .object({
    size: z.string().max(50).optional(),
    color: z.string().max(50).optional(),
    material: z.string().max(50).optional(),
    // Correctable after creation: unlike size/color/material these are not
    // identity, and a mis-typed barcode or unit must be fixable.
    barcode: BarcodeSchema.nullable().optional(),
    unitOfMeasure: UnitOfMeasureSchema.optional(),
    price: z.number().nonnegative().optional(),
    costPrice: z.number().nonnegative().nullable().optional(),
    mrp: z.number().nonnegative().nullable().optional(),
    listPrice: z.number().nonnegative().nullable().optional(),
    hsnSac: z.string().trim().regex(/^[0-9]{4,8}$/).nullable().optional(),
    purchaseUnit: z.string().trim().max(40).nullable().optional(),
    purchasePackSize: z.number().positive().nullable().optional(),
    trackInventory: z.boolean().optional(),
    allowNegativeStock: z.boolean().optional(),
    expiryDate: z.string().date().nullable().optional(),
    /** Percentage rate for this item. Omit to leave a legacy fallback unchanged. */
    taxRatePercent: z.number().min(0).max(100).optional(),
    reorderThreshold: z.number().nonnegative().optional(),
  })
  .openapi('UpdateVariantRequest')

export const UpdateProductSchema = z.object({
  brand: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(1_000).nullable().optional(),
  internalNotes: z.string().trim().max(1_000).nullable().optional(),
  isActive: z.boolean().optional(),
}).openapi('UpdateProductRequest')

export type Product = z.infer<typeof ProductSchema>
export type Variant = z.infer<typeof VariantSchema>
export type CreateProductInput = z.infer<typeof CreateProductSchema>
export type UpdateVariantInput = z.infer<typeof UpdateVariantSchema>
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>
