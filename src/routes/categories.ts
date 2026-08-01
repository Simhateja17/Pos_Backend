import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  CreateCategorySchema,
  STARTER_CATEGORIES,
  SeedCategoriesSchema,
  UpdateCategorySchema,
} from '../contracts/schemas/category'

const router = Router()

function toCategoryJson(row: any, productCount: number) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    productCount,
    createdAt: row.created_at.toISOString(),
  }
}

async function listWithCounts(client: any) {
  const categories = await client.categories.findMany({
    orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
  })
  const products = await client.products.findMany({ select: { category_id: true } })
  const counts = new Map<string, number>()
  for (const product of products) {
    if (product.category_id) counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1)
  }
  return categories.map((row: any) => toCategoryJson(row, counts.get(row.id) ?? 0))
}

/** GET / — the tenant's category list. Read is open; mutations are owner-only. */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  return res.json(await listWithCounts(client))
})

router.post('/', requireRole('owner'), async (req, res) => {
  const parsed = CreateCategorySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter a category name.' })
  }

  const client = forTenant(req.user!.tenantId) as any
  try {
    const created = await client.categories.create({
      data: {
        tenant_id: req.user!.tenantId,
        name: parsed.data.name,
        sort_order: parsed.data.sortOrder ?? 0,
      },
    })
    return res.status(201).json(toCategoryJson(created, 0))
  } catch (err: any) {
    // 0032's case-insensitive unique index — this is the guard that stops
    // "Dairy" and "dairy" both existing.
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You already have a category with that name' })
    }
    return res.status(500).json({ error: 'Could not create that category' })
  }
})

router.patch('/:categoryId', requireRole('owner'), async (req, res) => {
  const parsed = UpdateCategorySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  // RLS-scoped read first so another tenant's id cannot be renamed by guessing.
  const existing = await client.categories.findFirst({ where: { id: req.params.categoryId } })
  if (!existing) {
    return res.status(404).json({ error: 'Category not found' })
  }

  try {
    const updated = await client.categories.update({
      where: { id: req.params.categoryId },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.sortOrder !== undefined ? { sort_order: parsed.data.sortOrder } : {}),
      },
    })
    const products = await client.products.findMany({
      where: { category_id: updated.id },
      select: { id: true },
    })
    // Renaming updates every product at once precisely because the name lives in
    // one row rather than being copied onto each product.
    return res.json(toCategoryJson(updated, products.length))
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You already have a category with that name' })
    }
    return res.status(500).json({ error: 'Could not update that category' })
  }
})

/**
 * DELETE /:categoryId — products in a deleted category are NOT deleted; the FK
 * is ON DELETE SET NULL, so they simply become uncategorised. Said plainly in
 * the response so the owner is not guessing what happened to their stock.
 */
router.delete('/:categoryId', requireRole('owner'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.categories.findFirst({ where: { id: req.params.categoryId } })
  if (!existing) {
    return res.status(404).json({ error: 'Category not found' })
  }

  const affected = await client.products.findMany({
    where: { category_id: existing.id },
    select: { id: true },
  })
  await client.categories.delete({ where: { id: existing.id } })
  return res.json({ deleted: true, productsUncategorised: affected.length })
})

/**
 * POST /seed — starter categories for a shop type, chosen at signup.
 *
 * Deliberately additive and idempotent: it skips any name the tenant already
 * has (case-insensitively) rather than wiping and replacing, so running it
 * twice cannot destroy categories the owner has since edited.
 */
router.post('/seed', requireRole('owner'), async (req, res) => {
  const parsed = SeedCategoriesSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Pick a business type' })
  }

  const tenantId = req.user!.tenantId
  const client = forTenant(tenantId) as any

  const starters = STARTER_CATEGORIES[parsed.data.businessType]
  const existing = await client.categories.findMany({ select: { name: true } })
  const taken = new Set(existing.map((row: any) => row.name.trim().toLowerCase()))

  let created = 0
  for (const [index, name] of starters.entries()) {
    if (taken.has(name.toLowerCase())) continue
    try {
      await client.categories.create({
        data: { tenant_id: tenantId, name, sort_order: index },
      })
      created += 1
    } catch (err: any) {
      // A concurrent seed hitting the unique index is not an error worth
      // failing the whole request over — the category exists either way.
      if (err.code !== 'P2002') throw err
    }
  }

  await client.tenants.update({
    where: { id: tenantId },
    data: { business_type: parsed.data.businessType },
  })

  return res.json({ created, categories: await listWithCounts(client) })
})

export default router
