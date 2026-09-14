import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { activeStoreId } from '../middleware/storeContext'
import { forTenantTransaction } from '../db/tenantClient'
import { effectivePricesForVariants } from '../lib/storePricing'
import { computeCheckout } from '../lib/money'
import { SaleQuoteRequestSchema } from '../contracts/schemas/sale'
import { allowsFractionalQuantity } from '../contracts/schemas/product'

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
  try {
  const result = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    const store = await tx.stores.findFirst({ where: { id: storeId, is_active: true } })
    const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
    if (!store || !tenant) return { status: 404, body: { message: 'Store not found.' } }
    const quantities = new Map<string, number>()
    for (const line of parsed.data.lines) quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + line.quantity)
    const variants: any[] = []
    for (const line of parsed.data.lines) {
      const variant = await tx.variants.findFirst({ where: { id: line.variantId }, include: { products: { select: { name: true, is_active: true } } } })
      if (!variant) return { status: 404, body: { message: 'An item is no longer available.' } }
      if (!variant.products.is_active) return { status: 409, body: { message: 'An item is inactive.' } }
      if (!allowsFractionalQuantity(variant.unit_of_measure) && !Number.isInteger(line.quantity)) {
        return { status: 400, body: { code: 'INVALID_QUANTITY', message: `${variant.products.name} must use a whole quantity.` } }
      }
      variants.push(variant)
    }
    for (const [id, quantity] of quantities) {
      const variant = variants.find((candidate) => candidate.id === id)!
      if (variant.track_inventory && !variant.allow_negative_stock) {
        const stock = await tx.variant_stock_levels.findFirst({ where: { variant_id: id, store_id: storeId } })
        if (quantity > Number(stock?.quantity ?? 0)) return { status: 409, body: { code: 'INSUFFICIENT_STOCK', message: `${variant.products.name} has insufficient stock.` } }
      }
    }
    const prices = await effectivePricesForVariants(tx, storeId, variants)
    const taxRate = new Prisma.Decimal(store.tax_rate_state).plus(store.tax_rate_county).plus(store.tax_rate_city).plus(store.tax_rate_district)
    const checkoutLines = variants.map((variant, i) => {
      const line = parsed.data.lines[i]
      const lineValue = prices[i].times(line.quantity)
      const lineDiscount = line.discountAmount
        ? new Prisma.Decimal(line.discountAmount)
        : line.discountPercent
          ? lineValue.times(new Prisma.Decimal(line.discountPercent).dividedBy(100))
          : new Prisma.Decimal(0)
      return {
        price: prices[i], quantity: line.quantity, isTaxable: variant.is_taxable, lineDiscount,
        taxRate: variant.tax_rate == null ? taxRate : new Prisma.Decimal(variant.tax_rate),
      }
    })
    const amounts = computeCheckout({
      taxRate,
      lines: checkoutLines,
      cartDiscountPercent: parsed.data.cartDiscountPercent ? new Prisma.Decimal(parsed.data.cartDiscountPercent) : undefined,
      cartDiscountAmount: parsed.data.cartDiscountAmount ? new Prisma.Decimal(parsed.data.cartDiscountAmount) : undefined,
    })
    return { status: 200, body: {
      storeId, currency: tenant.country.toUpperCase() === 'IN' ? 'INR' : 'USD',
      subtotal: amounts.subtotal.toFixed(2), discountAmount: amounts.cartDiscount.toFixed(2), taxAmount: amounts.tax.toFixed(2), totalAmount: amounts.total.toFixed(2),
      lines: variants.map((variant, i) => ({ variantId: variant.id, productName: variant.products.name, quantity: parsed.data.lines[i].quantity, unitPrice: prices[i].toFixed(2) })),
    } }
  })
  return res.status(result.status).json(result.body)
  } catch (error: any) {
    if (error?.code === 'invalid_discount') return res.status(400).json({ code: 'INVALID_DISCOUNT', message: error.message })
    if (error?.code === 'invalid_tax_rate') return res.status(500).json({ code: 'INVALID_TAX_RATE', message: 'Store tax configuration is invalid.' })
    return res.status(500).json({ code: 'QUOTE_FAILED', message: 'Could not calculate the server total.' })
  }
})

export default router
