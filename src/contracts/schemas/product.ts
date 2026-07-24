import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// extendZodWithOpenApi is internally guarded (no-ops if already applied to this
// z instance) — safe to call again here, same pattern as contracts/schemas/member.ts.
extendZodWithOpenApi(z)

export const VariantSchema = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    sku: z.string(),
    size: z.string().nullable(),
    color: z.string().nullable(),
    material: z.string().nullable(),
    price: z.string(), // numeric(10,2) — serialized as a string to avoid float rounding, same convention to use in stockMovement.ts
    reorderThreshold: z.number().int(),
    identityLocked: z.boolean(),
    currentStock: z.number().int(),
    createdAt: z.string(),
  })
  .openapi('Variant')

export const ProductSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    category: z.string().nullable(),
    createdAt: z.string(),
    variants: z.array(VariantSchema),
  })
  .openapi('Product')

// D-03: sku is optional on input — omit to auto-generate, supply to override.
// Regex restricts to a safe charset (RESEARCH.md Security Domain V5) since this
// string is later encoded directly into a CODE128 barcode and used in URL paths.
export const CreateVariantInputSchema = z.object({
  sku: z.string().max(40).regex(/^[A-Za-z0-9-]+$/).optional(),
  size: z.string().max(50).optional(),
  color: z.string().max(50).optional(),
  material: z.string().max(50).optional(),
  price: z.number().nonnegative(),
  reorderThreshold: z.number().int().nonnegative().optional(),
})

// D-02: at least one variant is required — no product without stock-bearing variants.
export const CreateProductSchema = z
  .object({
    name: z.string().min(1),
    category: z.string().max(100).optional(),
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
    price: z.number().nonnegative().optional(),
    reorderThreshold: z.number().int().nonnegative().optional(),
  })
  .openapi('UpdateVariantRequest')

export type Product = z.infer<typeof ProductSchema>
export type Variant = z.infer<typeof VariantSchema>
export type CreateProductInput = z.infer<typeof CreateProductSchema>
export type UpdateVariantInput = z.infer<typeof UpdateVariantSchema>
