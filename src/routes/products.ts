import { Router } from 'express'
import { z } from 'zod'
import { CreateProductSchema, UpdateVariantSchema } from '../contracts/schemas/product'
import { forTenant, forTenantTransaction } from '../db/tenantClient'

const uuidSchema = z.string().uuid()

const router = Router()

type VariantRow = {
  id: string
  product_id: string
  sku: string
  barcode: string | null
  unit_of_measure: string
  size: string | null
  color: string | null
  material: string | null
  price: unknown // Prisma Decimal
  reorder_threshold: unknown // Prisma Decimal since 0031
  identity_locked: boolean
  created_at: Date
}

function toVariantJson(row: VariantRow, currentStock: number) {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    barcode: row.barcode,
    unitOfMeasure: row.unit_of_measure,
    size: row.size,
    color: row.color,
    material: row.material,
    price: row.price!.toString(),
    reorderThreshold: Number(row.reorder_threshold),
    identityLocked: row.identity_locked,
    currentStock,
    createdAt: row.created_at.toISOString(),
  }
}

async function categoryNames(client: any): Promise<Map<string, string>> {
  const rows = await client.categories.findMany({ select: { id: true, name: true } })
  return new Map(rows.map((row: any) => [row.id, row.name]))
}

function toProductJson(
  product: { id: string; name: string; category_id: string | null; created_at: Date },
  variants: ReturnType<typeof toVariantJson>[],
  categoryNameById: Map<string, string>,
) {
  return {
    id: product.id,
    name: product.name,
    categoryId: product.category_id,
    category: product.category_id ? (categoryNameById.get(product.category_id) ?? null) : null,
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
 * GET /?search= — list the caller's tenant's products with variants +
 * current stock. An optional `search` param filters to an exact-sku match
 * (CHECK-01's barcode-scan target, the same `sku` field Phase 2 encodes into
 * printed labels) OR a partial product-name match (CHECK-02), matching in
 * memory after the existing findMany calls (small-shop catalog scale,
 * consistent with this route's existing in-memory-join style — no
 * $queryRaw, which forTenant()'s wrapper does not intercept).
 * No requireRole gate — catalog viewing/management is not gated per CONTEXT.md
 * (only stock adjustments are, D-13, enforced in stockMovements.ts).
 */
router.get('/', async (req, res) => {
  const search = (req.query.search as string | undefined)?.trim().toLowerCase()
  const client = forTenant(req.user!.tenantId) as any
  const products = await client.products.findMany({ orderBy: { created_at: 'asc' } })
  const variants = await client.variants.findMany({ orderBy: { created_at: 'asc' } })
  const stockLevels = await client.variant_stock_levels.findMany({})
  const stockByVariant = new Map(stockLevels.map((s: any) => [s.variant_id, s.quantity]))
  const categoryNameById = await categoryNames(client)

  const filteredVariants = search
    ? variants.filter(
        (v: any) =>
          // Exact barcode match first: a scanned EAN is unambiguous and must not
          // be diluted by substring SKU hits.
          v.barcode === search ||
          v.sku.toLowerCase() === search ||
          v.sku.toLowerCase().includes(search),
      )
    : variants
  const relevantProductIds = search
    ? new Set([
        ...filteredVariants.map((v: any) => v.product_id),
        ...products.filter((p: any) => p.name.toLowerCase().includes(search)).map((p: any) => p.id),
      ])
    : null

  const result = products
    .filter((product: any) => !relevantProductIds || relevantProductIds.has(product.id))
    .map((product: any) => {
      const productVariants = variants
        .filter((v: any) => v.product_id === product.id)
        .map((v: VariantRow) => toVariantJson(v, Number(stockByVariant.get(v.id) ?? 0)))
      return toProductJson(product, productVariants, categoryNameById)
    })
  res.json(result)
})

/**
 * GET /:productId — single product with its variants + current stock.
 * Tenant scoping comes exclusively from forTenant(req.user.tenantId) — a
 * productId belonging to another tenant simply 404s.
 */
router.get('/:productId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.productId).success) {
    return res.status(400).json({ error: 'Invalid productId' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const product = await client.products.findFirst({ where: { id: req.params.productId } })
  if (!product) {
    return res.status(404).json({ error: 'Product not found' })
  }
  const variants = await client.variants.findMany({ where: { product_id: product.id } })
  const stockLevels = await client.variant_stock_levels.findMany({ where: { variant_id: { in: variants.map((v: any) => v.id) } } })
  const stockByVariant = new Map(stockLevels.map((s: any) => [s.variant_id, s.quantity]))
  const variantJson = variants.map((v: VariantRow) => toVariantJson(v, Number(stockByVariant.get(v.id) ?? 0)))
  res.json(toProductJson(product, variantJson, await categoryNames(client)))
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

  // Same reasoning for barcodes, which 0031 makes unique per tenant where
  // present. Two variants of one product cannot share a manufacturer code.
  const barcodes = parsed.data.variants.map((v) => v.barcode).filter((b): b is string => !!b)
  if (new Set(barcodes).size !== barcodes.length) {
    return res.status(400).json({ error: 'Duplicate barcode within request' })
  }

  const tenantId = req.user!.tenantId

  try {
    // CR-02: the whole product + N variants create runs as ONE real DB
    // transaction, not N independently-committed forTenant() calls — a
    // mid-loop failure (SKU collision, DB error) now rolls back the
    // product and every variant created so far, instead of leaving a
    // partial product permanently committed.
    const { product, createdVariants } = await forTenantTransaction(tenantId, async (tx) => {
      // Resolve the category to a real row. A typed name matches an existing
      // category case-insensitively before creating anything, so "dairy" joins
      // "Dairy" rather than forking it.
      let categoryId: string | null = parsed.data.categoryId ?? null
      if (!categoryId && parsed.data.categoryName) {
        const wanted = parsed.data.categoryName.trim()
        if (wanted) {
          const existing = await tx.categories.findFirst({
            where: { name: { equals: wanted, mode: 'insensitive' } },
            select: { id: true },
          })
          categoryId =
            existing?.id ??
            (await tx.categories.create({ data: { tenant_id: tenantId, name: wanted }, select: { id: true } })).id
        }
      }

      const product = await tx.products.create({
        data: { tenant_id: tenantId, name: parsed.data.name, category_id: categoryId },
      })

      const createdVariants: VariantRow[] = []
      for (let i = 0; i < parsed.data.variants.length; i++) {
        const input = parsed.data.variants[i]
        const sku = input.sku ?? (await generateSku(tx, tenantId, parsed.data.name, createdVariants.length, i))
        const variant = await tx.variants.create({
          data: {
            tenant_id: tenantId,
            product_id: product.id,
            sku,
            barcode: input.barcode ?? null,
            unit_of_measure: input.unitOfMeasure,
            size: input.size ?? null,
            color: input.color ?? null,
            material: input.material ?? null,
            price: input.price,
            reorder_threshold: input.reorderThreshold ?? 4,
          },
        })
        createdVariants.push(variant)
      }

      return { product, createdVariants }
    })

    const variantJson = createdVariants.map((v: VariantRow) => toVariantJson(v, 0))
    return res.status(201).json(toProductJson(product, variantJson, await categoryNames(forTenant(tenantId) as any)))
  } catch (err: any) {
    if (err.code === 'P2002') {
      // 0031 added a second unique constraint (tenant_id, barcode), so P2002 is
      // no longer necessarily about the SKU — say which one actually clashed.
      const target = String(err.meta?.target ?? '')
      return res.status(409).json({
        error: target.includes('barcode')
          ? 'A variant with that barcode already exists'
          : 'A variant with that SKU already exists',
      })
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
  if (!uuidSchema.safeParse(req.params.productId).success || !uuidSchema.safeParse(req.params.variantId).success) {
    return res.status(400).json({ error: 'Invalid productId or variantId' })
  }

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
        ...(parsed.data.barcode !== undefined ? { barcode: parsed.data.barcode } : {}),
        ...(parsed.data.unitOfMeasure !== undefined ? { unit_of_measure: parsed.data.unitOfMeasure } : {}),
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
