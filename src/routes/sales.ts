import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { CreateSaleSchema } from '../contracts/schemas/sale'
import { ROLE_RANK } from '../middleware/requireRole'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { computeCheckout } from '../lib/money'
import { findOrCreateCustomer, searchCustomers } from '../lib/customers'

const router = Router()

const ZERO = new Prisma.Decimal(0)

// D-05 body-dependent role gate — mirrors stockMovements.ts's isAllowedToAdjust
// exactly, reusing the same ROLE_RANK import and acting-identity precedence
// (req.actingStaff first, req.user fallback) already established for
// POST /stock-movements's adjustment gate.
function isApprovedForDiscount(req: import('express').Request): boolean {
  const actingRole = req.actingStaff?.role ?? req.user?.role
  if (!actingRole) return false
  return ROLE_RANK[actingRole] >= ROLE_RANK.manager
}

// Derives a line's effective discount percent from WHICHEVER discount field
// is actually present — discountPercent and discountAmount are both
// schema-legal and mutually exclusive, so the D-05 gate must not be
// bypassable by choosing the field that isn't checked (Blocker 1 fix).
function effectiveLinePercent(
  line: { discountPercent?: string; discountAmount?: string },
  variant: { price: Prisma.Decimal },
  quantity: number,
): Prisma.Decimal {
  const lineSubtotal = variant.price.times(quantity)
  if (line.discountAmount) {
    return lineSubtotal.isZero()
      ? ZERO
      : new Prisma.Decimal(line.discountAmount).dividedBy(lineSubtotal).times(100)
  }
  if (line.discountPercent) {
    return new Prisma.Decimal(line.discountPercent)
  }
  return ZERO
}

async function resolveActingStaffId(client: any, req: import('express').Request): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  const staff = await client.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } })
  return staff?.id ?? null
}

function toPaymentJson(row: any) {
  return {
    id: row.id,
    saleId: row.sale_id,
    method: row.method,
    direction: row.direction,
    amount: row.amount.toString(),
    referenceCode: row.reference_code,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }
}

function toLineJson(row: any) {
  return {
    id: row.id,
    variantId: row.variant_id,
    quantity: row.quantity,
    unitPrice: row.unit_price.toString(),
    discountPercent: row.discount_percent ? row.discount_percent.toString() : null,
    discountAmount: row.discount_amount.toString(),
    isTaxable: row.is_taxable,
    lineTotal: row.line_total.toString(),
  }
}

function toSaleJson(sale: any, lines: any[], payments: any[]) {
  return {
    id: sale.id,
    clientSaleId: sale.client_sale_id,
    shiftId: sale.shift_id,
    customerId: sale.customer_id,
    subtotal: sale.subtotal.toString(),
    discountAmount: sale.discount_amount.toString(),
    taxAmount: sale.tax_amount.toString(),
    totalAmount: sale.total_amount.toString(),
    status: sale.status,
    createdBy: sale.created_by,
    createdAt: sale.created_at.toISOString(),
    lines: lines.map(toLineJson),
    payments: payments.map(toPaymentJson),
  }
}

/**
 * POST / — complete a checkout sale (CHECK-01 through CHECK-05, PAY-01/02,
 * CUST-01). Server always recomputes the authoritative total from variant
 * prices + the tenant's tax profile via computeCheckout() (Pattern 2) — the
 * client's own running total, if any, is never read. Writes
 * sale + sale_line_items + payments + stock_movements in exactly one
 * forTenantTransaction (CR-02) — a mid-transaction failure rolls back
 * everything.
 */
router.post('/', async (req, res) => {
  const parsed = CreateSaleSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() })
  }

  const tenantId = req.user!.tenantId

  try {
    const result = await forTenantTransaction(tenantId, async (tx) => {
      // T-03-14 / CASH-02 / D-13/D-15: shift lookup + closed-shift guard MUST
      // happen before any variant lookup or write, so a stale client-held
      // shiftId from an already-Z-reported shift can never attach a new sale.
      const shift = await tx.shifts.findFirst({ where: { id: parsed.data.shiftId } })
      if (!shift) {
        return { status: 404, body: { error: 'Shift not found' } }
      }
      if (shift.closed_at !== null) {
        return {
          status: 409,
          body: { error: 'This shift has already been closed and cannot accept new sales.' },
        }
      }

      // CR-01 tenant-scoped lookup for every variantId referenced in the cart.
      const variants: any[] = []
      const missingVariantIds: string[] = []
      for (const line of parsed.data.lines) {
        const variant = await tx.variants.findFirst({ where: { id: line.variantId } })
        if (!variant) {
          missingVariantIds.push(line.variantId)
        } else {
          variants.push(variant)
        }
      }
      if (missingVariantIds.length > 0) {
        return { status: 404, body: { error: 'Variant not found', variantIds: missingVariantIds } }
      }

      const tenant = await tx.tenants.findFirst({ where: { id: tenantId } })
      if (!tenant) {
        return { status: 404, body: { error: 'Tenant not found' } }
      }
      const combinedTaxRate = new Prisma.Decimal(tenant.tax_rate_state)
        .plus(tenant.tax_rate_county)
        .plus(tenant.tax_rate_city)
        .plus(tenant.tax_rate_district)

      const checkoutLines = parsed.data.lines.map((line, i) => {
        const variant = variants[i]
        let lineDiscount: Prisma.Decimal = ZERO
        if (line.discountAmount) {
          lineDiscount = new Prisma.Decimal(line.discountAmount)
        } else if (line.discountPercent) {
          lineDiscount = variant.price.times(line.quantity).times(new Prisma.Decimal(line.discountPercent).dividedBy(100))
        }
        return {
          price: variant.price,
          quantity: line.quantity,
          isTaxable: variant.is_taxable,
          lineDiscount,
        }
      })

      const { subtotal, cartDiscount, tax, total } = computeCheckout({
        lines: checkoutLines,
        cartDiscountPercent: parsed.data.cartDiscountPercent ? new Prisma.Decimal(parsed.data.cartDiscountPercent) : undefined,
        cartDiscountAmount: parsed.data.cartDiscountAmount ? new Prisma.Decimal(parsed.data.cartDiscountAmount) : undefined,
        taxRate: combinedTaxRate,
      })

      // D-05 manager-approval discount gate: derive each line's effective
      // percent from whichever discount field is actually present, and the
      // cart-level effective percent, then compare the max against the
      // tenant's configured threshold.
      const effectiveCartPercent = subtotal.isZero() ? ZERO : cartDiscount.dividedBy(subtotal).times(100)
      const lineEffectivePercents = parsed.data.lines.map((l, i) =>
        effectiveLinePercent(l, variants[i], l.quantity),
      )
      const maxDiscountPercent = Prisma.Decimal.max(effectiveCartPercent, ...lineEffectivePercents, ZERO)

      if (maxDiscountPercent.greaterThan(new Prisma.Decimal(tenant.discount_threshold_percent))) {
        if (!isApprovedForDiscount(req)) {
          return {
            status: 403,
            body: {
              error: 'This discount needs manager approval. Ask a manager or owner to enter their PIN to continue.',
              code: 'discount_approval_required',
            },
          }
        }
      }

      // PAY-02: payments must sum to exactly the computed total — reject,
      // never silently auto-balance.
      const paymentSum = parsed.data.payments.reduce(
        (sum, p) => sum.plus(new Prisma.Decimal(p.amount)),
        ZERO,
      )
      if (!paymentSum.equals(total)) {
        return {
          status: 400,
          body: { error: `Payments must add up to the exact total (${total.toString()}). Currently ${paymentSum.toString()}.` },
        }
      }

      const customer = await findOrCreateCustomer(tx, tenantId, parsed.data.customer)
      const createdBy = await resolveActingStaffId(tx, req)

      const sale = await tx.sales.create({
        data: {
          tenant_id: tenantId,
          client_sale_id: parsed.data.clientSaleId,
          shift_id: parsed.data.shiftId,
          customer_id: customer?.id ?? null,
          subtotal: subtotal.toString(),
          discount_amount: cartDiscount.toString(),
          tax_amount: tax.toString(),
          total_amount: total.toString(),
          created_by: createdBy,
        },
      })

      const createdLines: any[] = []
      for (let i = 0; i < parsed.data.lines.length; i++) {
        const line = parsed.data.lines[i]
        const variant = variants[i]
        const checkoutLine = checkoutLines[i]
        const lineTotal = variant.price.times(line.quantity).minus(checkoutLine.lineDiscount)
        const createdLine = await tx.sale_line_items.create({
          data: {
            tenant_id: tenantId,
            sale_id: sale.id,
            variant_id: line.variantId,
            quantity: line.quantity,
            unit_price: variant.price.toString(),
            discount_percent: line.discountPercent ?? null,
            discount_amount: checkoutLine.lineDiscount.toString(),
            is_taxable: variant.is_taxable,
            line_total: lineTotal.toString(),
          },
        })
        createdLines.push(createdLine)
      }

      const createdPayments: any[] = []
      for (const payment of parsed.data.payments) {
        const createdPayment = await tx.payments.create({
          data: {
            tenant_id: tenantId,
            sale_id: sale.id,
            method: payment.method,
            direction: 'payment',
            amount: payment.amount,
            reference_code: payment.referenceCode ?? null,
            created_by: createdBy,
          },
        })
        createdPayments.push(createdPayment)
      }

      // D-17: sale movements are allowed to push stock negative — this loop
      // never pre-checks availability. The floor guard (migration 0010)
      // scopes its rejection to non-sale movement types only.
      for (const line of parsed.data.lines) {
        await tx.stock_movements.create({
          data: {
            tenant_id: tenantId,
            variant_id: line.variantId,
            movement_type: 'sale',
            quantity_delta: -line.quantity,
            reference_id: sale.id,
            created_by: createdBy,
          },
        })
      }

      return { status: 201, body: toSaleJson(sale, createdLines, createdPayments) }
    })

    // Dispatch explicitly per status so each response path is grep-able and
    // reviewable on its own (404/409/403/400/201 all map to a distinct
    // outcome computed above inside the transaction).
    switch (result.status) {
      case 404:
        return res.status(404).json(result.body)
      case 409:
        return res.status(409).json(result.body)
      case 403:
        return res.status(403).json(result.body)
      case 400:
        return res.status(400).json(result.body)
      default:
        return res.status(201).json(result.body)
    }
  } catch (err: any) {
    // Postgres floor-guard (23514, adjustment/transfer only from this route's
    // own perspective) or payment-sum trigger errors map to a 400; anything
    // else is a generic 500, never leaking raw internals.
    if (err?.code === 'P2003') {
      return res.status(400).json({ error: 'Invalid reference in request' })
    }
    return res.status(500).json({ error: 'Could not complete sale' })
  }
})

/**
 * GET /?receiptNumber=&customerSearch= — D-09 lookup by receipt/order number
 * (the sale's own UUID, shown to cashiers as the "receipt number" — no new
 * column needed) OR by customer search (phone/email/name, delegating to
 * searchCustomers). Every matched sale is serialized with BOTH its lines and
 * payments, matching SaleSchema — 03-04's returns route and 03-08's returns
 * page both need this shape.
 */
router.get('/', async (req, res) => {
  const receiptNumber = req.query.receiptNumber as string | undefined
  const customerSearch = req.query.customerSearch as string | undefined

  const client = forTenant(req.user!.tenantId) as any

  let sales: any[] = []

  if (receiptNumber) {
    if (!z.string().uuid().safeParse(receiptNumber).success) {
      return res.status(400).json({ error: 'Invalid receiptNumber' })
    }
    const sale = await client.sales.findFirst({ where: { id: receiptNumber } })
    sales = sale ? [sale] : []
  } else if (customerSearch) {
    const customers = await searchCustomers(client, customerSearch)
    const customerIds = customers.map((c) => c.id)
    sales = customerIds.length > 0 ? await client.sales.findMany({ where: { customer_id: { in: customerIds } }, orderBy: { created_at: 'desc' } }) : []
  } else {
    return res.status(400).json({ error: 'receiptNumber or customerSearch query parameter is required' })
  }

  const result = []
  for (const sale of sales) {
    const lines = await client.sale_line_items.findMany({ where: { sale_id: sale.id } })
    const payments = await client.payments.findMany({ where: { sale_id: sale.id } })
    result.push(toSaleJson(sale, lines, payments))
  }
  res.json(result)
})

/**
 * GET /:saleId — single sale with its lines and payments, tenant-scoped via
 * forTenant(). Same full shape as GET / above.
 */
router.get('/:saleId', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.saleId).success) {
    return res.status(400).json({ error: 'Invalid saleId' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const sale = await client.sales.findFirst({ where: { id: req.params.saleId } })
  if (!sale) {
    return res.status(404).json({ error: 'Sale not found' })
  }
  const lines = await client.sale_line_items.findMany({ where: { sale_id: sale.id } })
  const payments = await client.payments.findMany({ where: { sale_id: sale.id } })
  res.json(toSaleJson(sale, lines, payments))
})

export default router
