import { Router } from 'express'
import { CreateProductSchema, UpdateVariantSchema } from '../contracts/schemas/product'
import { forTenant } from '../db/tenantClient'

const router = Router()

type VariantRow = {
  id: string
  product_id: string
  sku: string
  size: string | null
  color: string | null
  material: string | null
  price: unknown // Prisma Decimal
  reorder_threshold: number
  identity_locked: boolean
  created_at: Date
}

function toVariantJson(row: VariantRow, currentStock: number) {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    size: row.size,
    color: row.color,
    material: row.material,
    price: row.price!.toString(),
    reorderThreshold: row.reorder_threshold,
    identityLocked: row.identity_locked,
    currentStock,
    createdAt: row.created_at.toISOString(),
  }
}

function toProductJson(product: { id: string; name: string; category: string | null; created_at: Date }, variants: ReturnType<typeof toVariantJson>[]) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    createdAt: product.created_at.toISOString(),
    variants,
  }
}

// D-03: prefix from the first 4 alphanumeric chars of the product name, uppercased,
// falling back to "PRD"; sequence = existing variant count for this product + attempt
// offset, retried up to 5 times on a tenant-scoped SKU collision (RESEARCH.md Pitfall 3
// option b — check-then-insert retry, acceptable at this phase's small-shop scale).
async function generateSku(client: any, tenantId: string, productName: string, existingCount: number, attemptOffset: number): Promise<string> {
  const prefix = productName.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'PRD'
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = existingCount + attemptOffset + attempt + 1
    const candidate = `${prefix}-${String(seq).padStart(4, '0')}`
    const clash = await client.variants.findFirst({ where: { tenant_id: tenantId, sku: candidate } })
    if (!clash) return candidate
  }
  throw Object.assign(new Error('Could not generate a unique SKU'), { status: 409 })
}

/**
 * GET / — list the caller's tenant's products with variants + current stock.
 * No requireRole gate — catalog viewing/management is not gated per CONTEXT.md
 * (only stock adjustments are, D-13, enforced in stockMovements.ts).
 */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const products = await client.products.findMany({ orderBy: { created_at: 'asc' } })
  const variants = await client.variants.findMany({ orderBy: { created_at: 'asc' } })
  const stockLevels = await client.variant_stock_levels.findMany({})
  const stockByVariant = new Map(stockLevels.map((s: any) => [s.variant_id, s.quantity]))

  const result = products.map((product: any) => {
    const productVariants = variants
      .filter((v: any) => v.product_id === product.id)
      .map((v: VariantRow) => toVariantJson(v, Number(stockByVariant.get(v.id) ?? 0)))
    return toProductJson(product, productVariants)
  })
  res.json(result)
})

/**
 * GET /:productId — single product with its variants + current stock.
 * Tenant scoping comes exclusively from forTenant(req.user.tenantId) — a
 * productId belonging to another tenant simply 404s.
 */
router.get('/:productId', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const product = await client.products.findFirst({ where: { id: req.params.productId } })
  if (!product) {
    return res.status(404).json({ error: 'Product not found' })
  }
  const variants = await client.variants.findMany({ where: { product_id: product.id } })
  const stockLevels = await client.variant_stock_levels.findMany({ where: { variant_id: { in: variants.map((v: any) => v.id) } } })
  const stockByVariant = new Map(stockLevels.map((s: any) => [s.variant_id, s.quantity]))
  const variantJson = variants.map((v: VariantRow) => toVariantJson(v, Number(stockByVariant.get(v.id) ?? 0)))
  res.json(toProductJson(product, variantJson))
})

/**
 * POST / — create a product with 1-N variants in one request (D-02). Each
 * variant gets an auto-generated SKU (D-03) unless the request supplies one.
 */
router.post('/', async (req, res) => {
  const parsed = CreateProductSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  // T-2-08 defense-in-depth: reject duplicate explicit SKUs within the same
  // request body before any DB write — a same-request collision would
  // otherwise only surface as a P2002 error on the second insert, after the
  // first variant has already been committed (partial success).
  const explicitSkus = parsed.data.variants.map((v) => v.sku).filter((sku): sku is string => !!sku)
  const hasDuplicateSku = new Set(explicitSkus).size !== explicitSkus.length
  if (hasDuplicateSku) {
    return res.status(400).json({ error: 'Duplicate SKU within request' })
  }

  const tenantId = req.user!.tenantId
  const client = forTenant(tenantId) as any

  try {
    const product = await client.products.create({
      data: { tenant_id: tenantId, name: parsed.data.name, category: parsed.data.category ?? null },
    })

    const createdVariants: VariantRow[] = []
    for (let i = 0; i < parsed.data.variants.length; i++) {
      const input = parsed.data.variants[i]
      const sku = input.sku ?? (await generateSku(client, tenantId, parsed.data.name, createdVariants.length, i))
      const variant = await client.variants.create({
        data: {
          tenant_id: tenantId,
          product_id: product.id,
          sku,
          size: input.size ?? null,
          color: input.color ?? null,
          material: input.material ?? null,
          price: input.price,
          reorder_threshold: input.reorderThreshold ?? 4,
        },
      })
      createdVariants.push(variant)
    }

    const variantJson = createdVariants.map((v) => toVariantJson(v, 0))
    return res.status(201).json(toProductJson(product, variantJson))
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A variant with that SKU already exists' })
    }
    return res.status(err.status ?? 500).json({ error: err.message ?? 'Could not create product' })
  }
})

/**
 * PATCH /:productId/variants/:variantId — edit a variant. Price/reorderThreshold
 * are always editable (D-04). size/color/material are blocked here AND by the
 * 0008 migration's BEFORE UPDATE trigger once identity_locked is true — this
 * app-level check gives a friendly 409 before the DB trigger would raise.
 */
router.patch('/:productId/variants/:variantId', async (req, res) => {
  const parsed = UpdateVariantSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const target = await client.variants.findFirst({ where: { id: req.params.variantId, product_id: req.params.productId } })
  if (!target) {
    return res.status(404).json({ error: 'Variant not found' })
  }

  const changingIdentity =
    (parsed.data.size !== undefined && parsed.data.size !== target.size) ||
    (parsed.data.color !== undefined && parsed.data.color !== target.color) ||
    (parsed.data.material !== undefined && parsed.data.material !== target.material)

  if (target.identity_locked && changingIdentity) {
    return res.status(409).json({ error: 'Variant identity is locked once stock has moved' })
  }

  try {
    const updated = await client.variants.update({
      where: { id: target.id },
      data: {
        ...(parsed.data.size !== undefined ? { size: parsed.data.size } : {}),
        ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        ...(parsed.data.material !== undefined ? { material: parsed.data.material } : {}),
        ...(parsed.data.price !== undefined ? { price: parsed.data.price } : {}),
        ...(parsed.data.reorderThreshold !== undefined ? { reorder_threshold: parsed.data.reorderThreshold } : {}),
      },
    })
    const stock = await client.variant_stock_levels.findFirst({ where: { variant_id: updated.id } })
    return res.status(200).json(toVariantJson(updated, Number(stock?.quantity ?? 0)))
  } catch {
    // Catches the DB trigger's raised exception too, as a defense-in-depth backstop.
    return res.status(409).json({ error: 'Variant identity is locked once stock has moved' })
  }
})

export default router
