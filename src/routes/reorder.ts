import { activeStoreId, storeScopeWhere } from '../middleware/storeContext'
import { Router } from 'express'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { generateReorderSuggestions, type SkippedVariant } from '../services/reorder-heuristic'
import { requireRole } from '../middleware/requireRole'

const router = Router()

export function toSuggestionJson(row: any) {
  const reason = row.reason ?? {}
  return {
    id: row.id,
    variantId: row.variant_id,
    sku: row.variants?.sku ?? '',
    productName: row.variants?.products?.name ?? '',
    supplierId: row.supplier_id,
    supplierName: row.suppliers?.name ?? null,
    suggestedQuantity: Number(row.suggested_quantity),
    method: row.method,
    confidence: row.confidence,
    // Rows generated before the structured ML-03 contract used `stock`.
    // Normalize at the API boundary so every client receives `currentStock`.
    reason: {
      ...reason,
      currentStock: Number(reason.currentStock ?? reason.stock ?? 0),
    },
    generatedAt: row.generated_at.toISOString(),
  }
}

/**
 * In-memory cache of the skipped list from the most recent generation run.
 * Skipped variants are explanatory context, not persisted facts — they are
 * regenerated whenever suggestions are, and an empty list after a restart
 * simply means "not computed since boot", which the UI reports honestly
 * rather than as "nothing was skipped".
 */
const lastSkipped = new Map<string, SkippedVariant[]>()

/**
 * GET / — the current suggestions for this tenant, newest run only.
 *
 * Deliberately does NOT generate on read: an owner refreshing a page should
 * see the same numbers, not a silently different set computed against stock
 * that moved between requests.
 */
router.get('/suggestions', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any

  // Suggestions are per shop, so "the latest run" must mean the latest run FOR
  // THIS SHOP — otherwise a shop that has not generated recently would show
  // another shop's run timestamp and then an empty list.
  const storeScope = storeScopeWhere(req)
  const latest = await client.reorder_suggestions.findFirst({
    where: { ...storeScope },
    orderBy: { generated_at: 'desc' },
  })
  if (!latest) {
    return res.json({ generatedAt: null, items: [], skipped: [] })
  }

  const rows = await client.reorder_suggestions.findMany({
    where: { generated_at: latest.generated_at, ...storeScope },
    include: { variants: { include: { products: true } }, suppliers: true },
    orderBy: { suggested_quantity: 'desc' },
  })

  res.json({
    generatedAt: latest.generated_at.toISOString(),
    items: rows.map(toSuggestionJson),
    skipped: lastSkipped.get(req.user!.tenantId) ?? [],
  })
})

/**
 * POST /generate — recompute suggestions for this tenant.
 *
 * Manager+ only: this replaces every existing suggestion, which changes what
 * the whole team sees on the Inventory screen.
 */
router.post('/generate', requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId

  try {
    const result = await forTenantTransaction(tenantId, async (tx) => generateReorderSuggestions(tx, tenantId, activeStoreId(req)))
    lastSkipped.set(tenantId, result.skipped)

    const client = forTenant(tenantId) as any
    const rows = await client.reorder_suggestions.findMany({
      where: { generated_at: result.generatedAt, store_id: activeStoreId(req) },
      include: { variants: { include: { products: true } }, suppliers: true },
      orderBy: { suggested_quantity: 'desc' },
    })

    return res.json({
      generatedAt: result.generatedAt.toISOString(),
      items: rows.map(toSuggestionJson),
      skipped: result.skipped,
    })
  } catch (err: any) {
    const status = Number.isInteger(err?.status) ? err.status : 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not generate reorder suggestions' : err.message ?? 'Could not generate reorder suggestions',
    })
  }
})

export default router
