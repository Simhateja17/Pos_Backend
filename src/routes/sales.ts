import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { CreateSaleSchema, ResendReceiptInputSchema, SaleListQuerySchema } from '../contracts/schemas/sale'
import { PaymentReadQuerySchema } from '../contracts/schemas/payment'
import { allowsFractionalQuantity } from '../contracts/schemas/product'
import { requireRole, ROLE_RANK } from '../middleware/requireRole'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { computeCheckout } from '../lib/money'
import { findOrCreateCustomer, searchCustomers } from '../lib/customers'
import { sendLoggedEmail } from '../services/email'
import { findPairedTerminal } from '../lib/counterDevice'
import { consumeRateLimit } from '../lib/rateLimit'

const router = Router()

const ZERO = new Prisma.Decimal(0)
const RECEIPT_RESEND_COOLDOWN_MS = 60 * 1000
const RECEIPT_RESEND_TENANT_WINDOW_MS = 60 * 60 * 1000
const RECEIPT_RESEND_TENANT_LIMIT = 100

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
    quantity: Number(row.quantity),
    unitPrice: row.unit_price.toString(),
    discountPercent: row.discount_percent ? row.discount_percent.toString() : null,
    discountAmount: row.discount_amount.toString(),
    isTaxable: row.is_taxable,
    lineTotal: row.line_total.toString(),
  }
}

function toSaleJson(sale: any, lines: any[], payments: any[], businessName?: string | null) {
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
    businessName: businessName ?? null,
  }
}

/**
 * OFFLINE-01 — load an already-committed sale by its client-supplied id.
 *
 * Returns the sale in exactly the shape POST / returns on first write, so a
 * replay is indistinguishable from the original response apart from its 200
 * status. Tenant-scoped through forTenant(), so a client_sale_id minted by
 * another tenant can never resolve here.
 */
async function loadSaleByClientSaleId(tenantId: string, clientSaleId: string) {
  const client = forTenant(tenantId) as any
  const sale = await client.sales.findFirst({ where: { client_sale_id: clientSaleId } })
  if (!sale) return null

  const [lines, payments, tenant] = await Promise.all([
    client.sale_line_items.findMany({ where: { sale_id: sale.id } }),
    client.payments.findMany({ where: { sale_id: sale.id, direction: 'payment' } }),
    client.tenants.findFirst({ where: { id: tenantId } }),
  ])

  return toSaleJson(sale, lines, payments, tenant?.business_name ?? null)
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
    const deviceClient = forTenant(tenantId) as any
    const pairedTerminal = await findPairedTerminal(deviceClient, req)
    const actingRole = req.actingStaff?.role ?? req.user!.role

    // OFFLINE-01 fast path. A retried or queue-redelivered sale must record
    // exactly once, so a client_sale_id we have already committed short-circuits
    // before any recompute or write. This is an optimisation and a nicety, NOT
    // the guarantee — the guarantee is the unique index from migration 0017,
    // which is what actually holds under concurrency. The catch block below
    // handles the race this lookup cannot.
    const replayed = await loadSaleByClientSaleId(tenantId, parsed.data.clientSaleId)
    if (replayed) {
      // 200 rather than 201: nothing was created by THIS request. The body is
      // byte-identical to the original 201 so a retrying client needs no
      // special-casing. No receipt email is re-sent — that already happened.
      return res.status(200).json(replayed)
    }

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
      if (actingRole === 'cashier' && !pairedTerminal) {
        return { status: 409, body: { error: 'This device is not paired to a counter.' } }
      }
      if (pairedTerminal && shift.terminal_id && shift.terminal_id !== pairedTerminal.id) {
        return { status: 409, body: { error: 'This sale belongs to a different counter.' } }
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

      // A fractional quantity is only meaningful for a variant sold by weight
      // or volume. Selling 2.5 of a `piece` variant is a typo, and the sale is
      // the one place it would silently become money.
      const fractionalErrors = parsed.data.lines
        .map((line, i) => ({ line, variant: variants[i] }))
        .filter(
          ({ line, variant }) =>
            !allowsFractionalQuantity(variant.unit_of_measure) && !Number.isInteger(line.quantity),
        )
      if (fractionalErrors.length > 0) {
        return {
          status: 400,
          body: {
            error: 'Quantity must be a whole number for variants sold by piece',
            variantIds: fractionalErrors.map(({ line }) => line.variantId),
          },
        }
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

      // CHECK-06: resolve the fire-and-forget receipt-email target — the
      // caller-supplied receiptEmail, else customer.email from the request,
      // else the found/created customer row's own on-file email. This is
      // captured here (still inside the transaction, before commit) since
      // `customer` and `tenant` are only in scope here; the actual send
      // happens AFTER the transaction commits and the HTTP response is sent.
      const receiptEmailTarget = parsed.data.receiptEmail ?? parsed.data.customer?.email ?? (customer as any)?.email ?? null

      return {
        status: 201,
        body: toSaleJson(sale, createdLines, createdPayments, tenant.business_name as string),
        receiptEmailTarget,
        businessName: tenant.business_name as string,
      }
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
      default: {
        const successBody = result.body as { id: string; totalAmount: string }
        res.status(201).json(successBody)
        // CHECK-06: fire-and-forget — deliberately NOT awaited. A slow/failed
        // email must never delay or fail the sale's own HTTP response (the
        // sale already committed above). `void` makes the intentional
        // non-await explicit; any { ok: false } outcome is logged
        // server-side only (T-03-15 — never surfaced to the client here).
        const receiptEmailTarget = (result as any).receiptEmailTarget as string | null
        const businessName = (result as any).businessName as string | undefined
        if (receiptEmailTarget) {
          // COMMS-01: still fire-and-forget, but now every attempt lands in
          // email_log with its outcome — a receipt that silently failed used to
          // leave nothing but a server log line the owner could not see.
          void sendLoggedEmail({
            tenantId: req.user!.tenantId,
            kind: 'receipt',
            to: receiptEmailTarget,
            saleId: successBody.id,
            subject: `Receipt from ${businessName ?? ''} — ${successBody.totalAmount}`,
            businessName: businessName ?? '',
            totalAmount: successBody.totalAmount,
          }).then((outcome) => {
            if (outcome.status !== 'sent') {
              // eslint-disable-next-line no-console
              console.error(`Receipt email ${outcome.status} for sale ${successBody.id}: ${outcome.reason ?? ''}`)
            }
          })
        }
        return
      }
    }
  } catch (err: any) {
    // OFFLINE-01 race path. Two concurrent submissions of the same
    // client_sale_id both miss the fast-path lookup, both compute, and both
    // attempt the insert; the unique index from 0017 lets exactly one commit
    // and rejects the other with P2002. The loser is not an error — its sale
    // demonstrably exists — so re-read and return it exactly as the winner did.
    // The whole write is one transaction, so the loser rolled back completely:
    // no orphan lines, payments, or stock movements.
    if (err?.code === 'P2002') {
      const winner = await loadSaleByClientSaleId(tenantId, parsed.data.clientSaleId)
      if (winner) {
        return res.status(200).json(winner)
      }
      // A P2002 on some other constraint, or the row vanished. Fall through.
    }
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
router.get('/payments', requireRole('manager'), async (req, res) => {
  const parsed = PaymentReadQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payment query' })

  const client = forTenant(req.user!.tenantId) as any
  const where: any = {}
  if (parsed.data.method) where.method = parsed.data.method
  if (parsed.data.status) where.direction = parsed.data.status === 'completed' ? 'payment' : 'refund'
  if (parsed.data.from || parsed.data.to || parsed.data.cursor) {
    where.created_at = {
      ...(parsed.data.from ? { gte: new Date(parsed.data.from) } : {}),
      ...(parsed.data.to ? { lte: new Date(parsed.data.to) } : {}),
      ...(parsed.data.cursor ? { lt: new Date(parsed.data.cursor) } : {}),
    }
  }

  // groupBy keeps payment totals authoritative: the browser receives the
  // persisted aggregate rather than recomputing collected/refunded money.
  const [rows, total, grouped] = await Promise.all([
    client.payments.findMany({
      where,
      include: { sales: { select: { status: true } } },
      orderBy: { created_at: 'desc' },
      take: parsed.data.limit + 1,
    }),
    client.payments.count({ where }),
    client.payments.groupBy({ by: ['direction'], where, _sum: { amount: true } }),
  ])
  const hasMore = rows.length > parsed.data.limit
  const page = rows.slice(0, parsed.data.limit)
  const collected = grouped.find((entry: any) => entry.direction === 'payment')?._sum.amount ?? ZERO
  const refunded = grouped.find((entry: any) => entry.direction === 'refund')?._sum.amount ?? ZERO
  const collectedAmount = new Prisma.Decimal(collected).toFixed(2)
  const refundedAmount = new Prisma.Decimal(refunded).toFixed(2)

  return res.json({
    items: page.map((payment: any) => ({ ...toPaymentJson(payment), saleStatus: payment.sales.status })),
    total,
    nextCursor: hasMore ? page[page.length - 1].created_at.toISOString() : null,
    summary: {
      collectedAmount,
      refundedAmount,
      netAmount: new Prisma.Decimal(collectedAmount).minus(refundedAmount).toFixed(2),
    },
  })
})

router.get('/records', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const parsed = SaleListQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid sale query' })
  const where: any = {}

  // Cashiers may browse the sales currently being rung up on this physical
  // counter, but never the organisation-wide ledger. Historical lookup stays
  // available below only through an explicit receipt number or customer phone.
  const actingRole = req.actingStaff?.role ?? req.user!.role
  if (actingRole === 'cashier') {
    const terminal = await findPairedTerminal(client, req)
    if (!terminal) return res.status(409).json({ error: 'This device is not paired to a counter.' })
    const currentShift = await client.shifts.findFirst({
      where: { terminal_id: terminal.id, closed_at: null },
      select: { id: true },
    })
    if (!currentShift) return res.json({ items: [], total: 0, nextCursor: null })
    where.shift_id = currentShift.id
  }
  if (parsed.data.status) where.status = parsed.data.status
  if (parsed.data.from || parsed.data.to || parsed.data.cursor) {
    where.created_at = {
      ...(parsed.data.from ? { gte: new Date(parsed.data.from) } : {}),
      ...(parsed.data.to ? { lte: new Date(parsed.data.to) } : {}),
      ...(parsed.data.cursor ? { lt: new Date(parsed.data.cursor) } : {}),
    }
  }
  if (parsed.data.search) {
    const customers = await searchCustomers(client, parsed.data.search)
    const customerIds = customers.map((customer) => customer.id)
    where.OR = [
      ...(z.string().uuid().safeParse(parsed.data.search).success ? [{ id: parsed.data.search }] : []),
      ...(customerIds.length ? [{ customer_id: { in: customerIds } }] : []),
    ]
    if (where.OR.length === 0) return res.json({ items: [], total: 0, nextCursor: null })
  }

  const [rows, total] = await Promise.all([
    client.sales.findMany({ where, orderBy: { created_at: 'desc' }, take: parsed.data.limit + 1 }),
    client.sales.count({ where }),
  ])
  const hasMore = rows.length > parsed.data.limit
  const page = rows.slice(0, parsed.data.limit)
  const items = []
  for (const sale of page) {
    const [lines, payments] = await Promise.all([
      client.sale_line_items.findMany({ where: { sale_id: sale.id } }),
      client.payments.findMany({ where: { sale_id: sale.id } }),
    ])
    items.push(toSaleJson(sale, lines, payments))
  }
  return res.json({
    items,
    total,
    nextCursor: hasMore ? page[page.length - 1].created_at.toISOString() : null,
  })
})

router.get('/', async (req, res) => {
  const receiptNumber = req.query.receiptNumber as string | undefined
  const customerSearch = req.query.customerSearch as string | undefined
  if (!receiptNumber && !customerSearch) {
    return res.status(400).json({ error: 'receiptNumber or customerSearch query parameter is required' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const actingRole = req.actingStaff?.role ?? req.user!.role
  let sales: any[] = []
  if (receiptNumber) {
    if (!z.string().uuid().safeParse(receiptNumber).success) {
      return res.status(400).json({ error: 'Invalid receiptNumber' })
    }
    const sale = await client.sales.findFirst({ where: { id: receiptNumber } })
    sales = sale ? [sale] : []
  } else if (customerSearch) {
    const customers = actingRole === 'cashier'
      ? await client.customers.findMany({
          where: { phone: { contains: customerSearch.trim() } },
          orderBy: { created_at: 'desc' },
          take: 20,
        })
      : await searchCustomers(client, customerSearch)
    const customerIds = customers.map((c: { id: string }) => c.id)
    sales = customerIds.length > 0 ? await client.sales.findMany({ where: { customer_id: { in: customerIds } }, orderBy: { created_at: 'desc' } }) : []
  }
  const result = []
  for (const sale of sales) {
    const lines = await client.sale_line_items.findMany({ where: { sale_id: sale.id } })
    const payments = await client.payments.findMany({ where: { sale_id: sale.id } })
    result.push(toSaleJson(sale, lines, payments))
  }
  return res.json(result)
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

/**
 * POST /:saleId/resend-receipt — CHECK-06's real retriable resend endpoint.
 * Unlike the fire-and-forget call on the original charge path, this handler
 * `await`s sendReceiptEmail directly and returns its REAL outcome — the
 * entire point of this endpoint is to report success/failure synchronously
 * to the caller, so the frontend never has to fabricate an outcome.
 */
router.post('/:saleId/resend-receipt', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.saleId).success) {
    return res.status(400).json({ error: 'Invalid saleId' })
  }

  const parsed = ResendReceiptInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  // CR-01/T-03-19: tenant-scoped lookup — a saleId belonging to another
  // tenant simply returns 404, identical to every other tenant-scoped miss
  // elsewhere in this codebase.
  const sale = await client.sales.findFirst({ where: { id: req.params.saleId } })
  if (!sale) {
    return res.status(404).json({ error: 'Sale not found' })
  }

  const customer = sale.customer_id
    ? await client.customers.findFirst({ where: { id: sale.customer_id } })
    : null
  const onFileEmail = customer?.email?.trim().toLowerCase() ?? null
  let email = parsed.data.email?.trim()
  const actingRole = req.actingStaff?.role ?? req.user!.role

  // A cashier may resend to the customer's stored address, but changing the
  // destination is a manager-level trust decision. This prevents the endpoint
  // from becoming an authenticated arbitrary-mail sender.
  if (email && email.trim().toLowerCase() !== onFileEmail && ROLE_RANK[actingRole] < ROLE_RANK.manager) {
    return res.status(403).json({ error: 'A manager must approve sending this receipt to a different address.' })
  }
  if (!email && onFileEmail) email = customer!.email
  if (!email) {
    return res.status(400).json({ error: 'No email address is on file for this sale — enter one to send a receipt.' })
  }

  const recipient = email.trim().toLowerCase()
  const actorId = req.actingStaff?.id ?? req.user!.id
  const cooldown = consumeRateLimit(
    `receipt-resend:${req.user!.tenantId}:${actorId}:${sale.id}:${recipient}`,
    1,
    RECEIPT_RESEND_COOLDOWN_MS,
  )
  const tenantBudget = consumeRateLimit(
    `receipt-resend-tenant:${req.user!.tenantId}`,
    RECEIPT_RESEND_TENANT_LIMIT,
    RECEIPT_RESEND_TENANT_WINDOW_MS,
  )
  if (!cooldown.allowed || !tenantBudget.allowed) {
    const retryAfter = Math.max(cooldown.retryAfterSeconds, tenantBudget.retryAfterSeconds)
    res.set('Retry-After', String(retryAfter))
    return res.status(429).json({ error: 'This receipt was sent recently. Please try again later.' })
  }

  const tenant = await client.tenants.findFirst({ where: { id: req.user!.tenantId } })
  const result = await sendLoggedEmail({
    tenantId: req.user!.tenantId,
    kind: 'receipt',
    to: email,
    saleId: sale.id,
    subject: `Receipt from ${tenant?.business_name ?? ''} — ${sale.total_amount.toString()}`,
    businessName: tenant?.business_name ?? '',
    totalAmount: sale.total_amount.toString(),
    createdBy: actorId,
  })

  if (result.status === 'suppressed') {
    // A receipt is transactional, so only a bounce or a spam complaint reaches
    // here — an unsubscribe does not suppress it. Say which, because the fix
    // differs: a wrong address needs correcting, a complaint does not.
    return res.status(409).json({
      error:
        result.reason === 'complained'
          ? 'This address reported an earlier email as spam, so we no longer send to it. Use a different address.'
          : 'Email to this address bounced before, so we no longer send to it. Check the address and try another.',
    })
  }

  if (result.status !== 'sent') {
    // T-03-15: never forward the raw provider error to the client — only the
    // exact UI-SPEC copy contract string.
    return res.status(502).json({
      error: "Couldn't send the receipt email. The sale is saved — try emailing it again from the receipt lookup.",
    })
  }

  return res.status(200).json({ ok: true, email })
})

export default router
