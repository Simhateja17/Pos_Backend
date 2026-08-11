import { Router } from 'express'
import { z } from 'zod'
import { CreateProductSchema, UpdateVariantSchema } from '../contracts/schemas/product'
import { stockByVariant as stockLevelsFor, stockForVariant } from '../lib/stockLevels'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import { activeStoreId } from '../middleware/storeContext'
import { effectivePricesForVariants } from '../lib/storePricing'
import { findExactVariant } from '../services/catalogLookup'

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
  is_taxable: boolean
  reorder_threshold: unknown // Prisma Decimal since 0031
  identity_locked: boolean
  created_at: Date
}

function toVariantJson(row: VariantRow, currentStock: number, effectivePrice: unknown = row.price) {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    barcode: row.barcode,
    unitOfMeasure: row.unit_of_measure,
    size: row.size,
    color: row.color,
    material: row.material,
    price: effectivePrice!.toString(),
    isTaxable: row.is_taxable,
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
 * Cap on how many products a `?search=` may return. Only the substring
 * fallback can reach it — an exact barcode/SKU hit short-circuits to a single
 * product. Unsearched listing stays uncapped: the catalog, labels and
 * inventory screens all render the full list and have no paging UI.
 */
const SEARCH_RESULT_LIMIT = 50

/**
 * Resolves a search string to the product ids it should return, exact match
 * first. Returns [] for "searched, matched nothing" — the caller must not
 * confuse that with `null`, which means "no search, return everything".
 */
async function matchingProductIds(client: any, search: string, tenantId: string): Promise<string[]> {
  // Step 1 — exact code, the path a barcode scan takes. Both
  // (tenant_id, barcode) [0031] and (tenant_id, sku) [0006] are unique
  // indexes, so this is a single index lookup at any catalog size.
  //
  // Barcode is compared before, and separately from, SKU: a scanned EAN is
  // unambiguous and must not be diluted by a SKU that merely contains the
  // same digits. It is also compared case-sensitively, being digits-only by
  // schema (BarcodeSchema); SKU is not, so it needs an insensitive compare to
  // preserve the old lowercase-both behaviour.
  const exact = await findExactVariant(client, search, tenantId)
  if (exact) {
    return exact.product_id ? [exact.product_id] : []
  }

  // Step 2 — substring fallback (CHECK-02: search by name when there is no
  // barcode). ILIKE '%...%', served by 0050's pg_trgm GIN indexes.
  const matches = await client.products.findMany({
    where: {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: search, mode: 'insensitive' } } } },
      ],
    },
    orderBy: { created_at: 'asc' },
    take: SEARCH_RESULT_LIMIT,
    select: { id: true },
  })
  return matches.map((p: { id: string }) => p.id)
}

/**
 * GET /?search= — list the caller's tenant's products with variants +
 * current stock.
 *
 * Filtering happens in SQL. The previous implementation pulled every product
 * and variant for the tenant into Node and filtered with Array.filter, which
 * made a barcode scan — the one interaction that has to feel instant —
 * proportional to catalog size. At the 2,000-10,000 SKU tier the roadmap
 * targets that is the wrong shape.
 *
 * Matching is BY PRODUCT: a product whose name matches returns all of its
 * variants, not only the matching ones. That is the pre-existing contract and
 * the checkout result list depends on it.
 *
 * Stock still goes through stockLevelsFor(), never a join. Since Phase 8
 * `variant_stock_levels` holds one row per (variant, store), so joining it
 * here would fan out one product row per shop — the bug that double-counted
 * the stock-valuation report. The helper aggregates correctly for both store
 * and business scope.
 *
 * Prisma model queries throughout, never $queryRaw: the tenant wrapper does
 * not intercept raw SQL, so a raw query would run without app.tenant_id set
 * and fall outside RLS.
 *
 * No requireRole gate — catalog viewing/management is not gated per CONTEXT.md
 * (only stock adjustments are, D-13, enforced in stockMovements.ts).
 */
router.get('/', async (req, res) => {
  const search = (req.query.search as string | undefined)?.trim()
  const client = forTenant(req.user!.tenantId) as any

  const productIds = search ? await matchingProductIds(client, search, req.user!.tenantId) : null
  if (productIds !== null && productIds.length === 0) {
    return res.json([])
  }

  const products = await client.products.findMany({
    ...(productIds !== null ? { where: { id: { in: productIds } } } : {}),
    orderBy: { created_at: 'asc' },
    include: { variants: { orderBy: { created_at: 'asc' } } },
  })

  const variantRows: VariantRow[] = products.flatMap((p: any) => p.variants as VariantRow[])
  const variantIds = variantRows.map((variant) => variant.id)
  const stockByVariant = await stockLevelsFor(client, req, variantIds)
  const categoryNameById = await categoryNames(client)
  const effectivePrices = req.storeContext?.scope === 'store'
    ? await effectivePricesForVariants(client, activeStoreId(req), variantRows as any)
    : variantRows.map((variant) => variant.price)
  const effectivePriceByVariant = new Map(variantRows.map((variant, index) => [variant.id, effectivePrices[index]]))

  res.json(
    products.map((product: any) =>
      toProductJson(
        product,
        product.variants.map((v: VariantRow) =>
          toVariantJson(v, Number(stockByVariant.get(v.id) ?? 0), effectivePriceByVariant.get(v.id)),
        ),
        categoryNameById,
      ),
    ),
  )
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
  const stockByVariant = await stockLevelsFor(client, req, variants.map((v: any) => v.id))
  const effectivePrices = req.storeContext?.scope === 'store'
    ? await effectivePricesForVariants(client, activeStoreId(req), variants)
    : variants.map((variant: any) => variant.price)
  const variantJson = variants.map((v: VariantRow, index: number) =>
    toVariantJson(v, Number(stockByVariant.get(v.id) ?? 0), effectivePrices[index]),
  )
  res.json(toProductJson(product, variantJson, await categoryNames(client)))
})

/**
 * POST / — create a product with 1-N variants in one request (D-02). Each
 * variant gets an auto-generated SKU (D-03) unless the request supplies one.
 */
router.post('/', requireRole('manager'), async (req, res) => {
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
    const status = Number.isInteger(err?.status) ? err.status : 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not create product' : err.message ?? 'Could not create product',
    })
  }
})

/**
 * PATCH /:productId/variants/:variantId — edit a variant. Price/reorderThreshold
 * are always editable (D-04). size/color/material are blocked here AND by the
 * 0008 migration's BEFORE UPDATE trigger once identity_locked is true — this
 * app-level check gives a friendly 409 before the DB trigger would raise.
 */
router.patch('/:productId/variants/:variantId', requireRole('manager'), async (req, res) => {
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
    const quantity = await stockForVariant(client, req, updated.id)
    return res.status(200).json(toVariantJson(updated, quantity))
  } catch {
    // Catches the DB trigger's raised exception too, as a defense-in-depth backstop.
    return res.status(409).json({ error: 'Variant identity is locked once stock has moved' })
  }
})

export default router
