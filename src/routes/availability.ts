import { Router } from 'express'
import { forTenantTransaction } from '../db/tenantClient'

const router = Router({ mergeParams: true })

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /variants/:variantId/availability — where else in this business is it?
 *
 * The reason a chain is worth running: a customer asks for blue, this shop is
 * out, and the cashier can say "Bandra has three" instead of losing the sale.
 *
 * OPEN TO EVERY ROLE, including cashiers, and deliberately so. But it returns
 * QUANTITY ONLY. Another shop's sales, takings and shift figures remain scoped
 * to the shop a person works in — see contracts/schemas/availability.ts. The
 * restriction is enforced here by selecting only the columns that may be
 * returned, not by trimming a wider object afterwards, so a future `select: *`
 * cannot quietly widen it.
 *
 * Everything is read inside the tenant transaction, so RLS confines it to the
 * caller's own business. There is no store filter: seeing sibling shops IS the
 * feature, and the tenant boundary is what makes that safe.
 */
router.get('/', async (req, res) => {
  const variantId = (req.params as { variantId?: string }).variantId

  if (!UUID_PATTERN.test(variantId ?? '')) {
    return res.status(400).json({ error: 'Invalid variant id' })
  }

  const result = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const variant = await tx.variants.findFirst({
      where: { id: variantId },
      select: { id: true, sku: true, products: { select: { name: true } } },
    })
    if (!variant) return null

    // Active shops only. A deactivated outlet's shelf is not somewhere a
    // customer can be sent, so listing it would be worse than omitting it.
    const stores = await tx.stores.findMany({
      where: { is_active: true },
      select: { id: true, name: true },
    })

    const levels = await tx.variant_stock_levels.findMany({
      where: { variant_id: variantId },
      select: { store_id: true, quantity: true },
    })

    return { variant, stores, levels }
  })

  if (!result) {
    return res.status(404).json({ error: 'Variant not found' })
  }

  const quantityByStore = new Map<string, unknown>(
    result.levels.map((level: any) => [level.store_id, level.quantity]),
  )

  const ownStoreId = req.user!.storeId

  const stores = result.stores
    .map((store: any) => ({
      storeId: store.id,
      storeName: store.name,
      // A shop with no ledger row for this variant has genuinely never held
      // one, so 0 is the honest answer rather than an omission.
      quantity: String(quantityByStore.get(store.id) ?? 0),
      isOwnStore: store.id === ownStoreId,
    }))
    .sort((a: any, b: any) => {
      if (a.isOwnStore !== b.isOwnStore) return a.isOwnStore ? -1 : 1
      return Number(b.quantity) - Number(a.quantity)
    })

  return res.json({
    variantId: result.variant.id,
    sku: result.variant.sku,
    productName: result.variant.products?.name ?? '',
    stores,
  })
})

export default router
