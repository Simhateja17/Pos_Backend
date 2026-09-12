import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { activeStoreId } from '../middleware/storeContext'
import { forTenantTransaction } from '../db/tenantClient'
import { effectivePricesForVariants } from '../lib/storePricing'
import { computeCheckout } from '../lib/money'
import { SaleQuoteRequestSchema } from '../contracts/schemas/sale'

const router = Router()

// Mounted inside sales, so the same auth, operator, subscription and store
// middleware applies. This route performs no writes and reserves no stock.
router.post('/quote', async (req, res) => {
  const parsed = SaleQuoteRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Choose items and whole positive quantities.' })
  let storeId: string
  try { storeId = activeStoreId(req) } catch {
    return res.status(400).json({ code: 'STORE_REQUIRED', message: 'Choose a store before requesting a total.' })
  }
  const result = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    const store = await tx.stores.findFirst({ where: { id: storeId, is_active: true } })
    const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
    if (!store || !tenant) return { status: 404, body: { message: 'Store not found.' } }
    const quantities = new Map<string, number>()
    for (const line of parsed.data.lines) quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + line.quantity)
    const variants: any[] = []
    for (const [id, quantity] of quantities) {
      const variant = await tx.variants.findFirst({ where: { id }, include: { products: { select: { name: true, is_active: true } } } })
      if (!variant) return { status: 404, body: { message: 'An item is no longer available.' } }
      if (!variant.products.is_active) return { status: 409, body: { message: 'An item is inactive.' } }
      if (variant.track_inventory && !variant.allow_negative_stock) {
        const stock = await tx.variant_stock_levels.findFirst({ where: { variant_id: id, store_id: storeId } })
        if (quantity > Number(stock?.quantity ?? 0)) return { status: 409, body: { code: 'INSUFFICIENT_STOCK', message: `${variant.products.name} has insufficient stock.` } }
      }
      variants.push(variant)
    }
    const prices = await effectivePricesForVariants(tx, storeId, variants)
    const taxRate = new Prisma.Decimal(store.tax_rate_state).plus(store.tax_rate_county).plus(store.tax_rate_city).plus(store.tax_rate_district)
    const amounts = computeCheckout({ taxRate, lines: variants.map((variant, i) => ({
      price: prices[i], quantity: quantities.get(variant.id)!, isTaxable: variant.is_taxable,
      taxRate: variant.tax_rate == null ? taxRate : new Prisma.Decimal(variant.tax_rate),
    })) })
    return { status: 200, body: {
      storeId, currency: tenant.country.toUpperCase() === 'IN' ? 'INR' : 'USD',
      subtotal: amounts.subtotal.toFixed(2), taxAmount: amounts.tax.toFixed(2), totalAmount: amounts.total.toFixed(2),
      lines: variants.map((variant, i) => ({ variantId: variant.id, productName: variant.products.name, quantity: quantities.get(variant.id)!, unitPrice: prices[i].toFixed(2) })),
    } }
  })
  return res.status(result.status).json(result.body)
})

export default router
