import { Router } from 'express'
import { z } from 'zod'
import {
  CreatePurchaseOrderSchema,
  ReceivePurchaseOrderSchema,
  UpdatePurchaseOrderSchema,
} from '../contracts/schemas/purchaseOrder'
import { forTenant, forTenantTransaction } from '../db/tenantClient'

const uuidSchema = z.string().uuid()

const router = Router()

function decimalToString(value: unknown): string {
  return (value as { toString(): string }).toString()
}

function toPurchaseOrderJson(po: any) {
  const lines = (po.purchase_order_lines ?? []).map((line: any) => ({
    id: line.id,
    variantId: line.variant_id,
    sku: line.variants?.sku ?? '',
    productName: line.variants?.products?.name ?? '',
    quantityOrdered: Number(line.quantity_ordered),
    quantityReceived: Number(line.quantity_received),
    unitCost: decimalToString(line.unit_cost),
    lineTotal: (Number(line.unit_cost) * Number(line.quantity_ordered)).toFixed(2),
  }))

  return {
    id: po.id,
    poNumber: po.po_number,
    supplierId: po.supplier_id,
    supplierName: po.suppliers?.name ?? '',
    status: po.status,
    expectedDate: po.expected_date ? po.expected_date.toISOString().slice(0, 10) : null,
    notes: po.notes,
    totalCost: lines.reduce((sum: number, l: any) => sum + Number(l.lineTotal), 0).toFixed(2),
    lines,
    createdAt: po.created_at.toISOString(),
  }
}

const PO_INCLUDE = {
  suppliers: true,
  purchase_order_lines: { include: { variants: { include: { products: true } } }, orderBy: { created_at: 'asc' as const } },
}

/**
 * Per-tenant PO number: PO-0001, PO-0002, ... The (tenant_id, po_number)
 * unique index is the real guard — a concurrent create that collides retries
 * against the next free number rather than failing the request.
 */
async function nextPoNumber(tx: any, tenantId: string, attempt: number): Promise<string> {
  const count = await tx.purchase_orders.count({ where: { tenant_id: tenantId } })
  return `PO-${String(count + 1 + attempt).padStart(4, '0')}`
}

router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const statusFilter = req.query.status as string | undefined
  const orders = await client.purchase_orders.findMany({
    where: statusFilter ? { status: statusFilter } : undefined,
    include: PO_INCLUDE,
    orderBy: { created_at: 'desc' },
  })
  res.json(orders.map(toPurchaseOrderJson))
})

router.get('/:poId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.poId).success) {
    return res.status(400).json({ error: 'Invalid purchase order id' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const po = await client.purchase_orders.findFirst({ where: { id: req.params.poId }, include: PO_INCLUDE })
  if (!po) return res.status(404).json({ error: 'Purchase order not found' })
  res.json(toPurchaseOrderJson(po))
})

/** POST / — raise a draft PO. */
router.post('/', async (req, res) => {
  const parsed = CreatePurchaseOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' })

  const variantIds = parsed.data.lines.map((l) => l.variantId)
  if (new Set(variantIds).size !== variantIds.length) {
    return res.status(400).json({ error: 'A variant can appear only once per purchase order' })
  }

  const tenantId = req.user!.tenantId

  try {
    const po = await forTenantTransaction(tenantId, async (tx) => {
      const supplier = await tx.suppliers.findFirst({ where: { id: parsed.data.supplierId } })
      if (!supplier) throw Object.assign(new Error('Supplier not found'), { status: 404 })

      const variants = await tx.variants.findMany({ where: { id: { in: variantIds } } })
      if (variants.length !== variantIds.length) {
        throw Object.assign(new Error('One or more variants were not found'), { status: 400 })
      }

      let created: any = null
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        const poNumber = await nextPoNumber(tx, tenantId, attempt)
        try {
          created = await tx.purchase_orders.create({
            data: {
              tenant_id: tenantId,
              supplier_id: parsed.data.supplierId,
              po_number: poNumber,
              status: 'draft',
              expected_date: parsed.data.expectedDate ? new Date(parsed.data.expectedDate) : null,
              notes: parsed.data.notes ?? null,
            },
          })
        } catch (err: any) {
          if (err.code !== 'P2002') throw err
        }
      }
      if (!created) throw Object.assign(new Error('Could not allocate a purchase order number'), { status: 409 })

      for (const line of parsed.data.lines) {
        await tx.purchase_order_lines.create({
          data: {
            tenant_id: tenantId,
            purchase_order_id: created.id,
            variant_id: line.variantId,
            quantity_ordered: line.quantityOrdered,
            unit_cost: line.unitCost,
          },
        })
      }

      return tx.purchase_orders.findFirst({ where: { id: created.id }, include: PO_INCLUDE })
    })

    return res.status(201).json(toPurchaseOrderJson(po))
  } catch (err: any) {
    const status = Number.isInteger(err?.status) ? err.status : 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not create purchase order' : err.message ?? 'Could not create purchase order',
    })
  }
})

/**
 * PATCH /:poId — send or cancel a draft, or edit its expected date / notes.
 * `partial` and `received` are derived by the receipt trigger and cannot be
 * set by a caller.
 */
router.patch('/:poId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.poId).success) {
    return res.status(400).json({ error: 'Invalid purchase order id' })
  }
  const parsed = UpdatePurchaseOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' })

  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.purchase_orders.findFirst({ where: { id: req.params.poId } })
  if (!existing) return res.status(404).json({ error: 'Purchase order not found' })

  if (parsed.data.status && !['draft', 'sent'].includes(existing.status)) {
    return res.status(409).json({
      error: `A purchase order that is already ${existing.status} cannot be changed`,
    })
  }

  await client.purchase_orders.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.expectedDate !== undefined ? { expected_date: new Date(parsed.data.expectedDate) } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    },
  })
  const updated = await client.purchase_orders.findFirst({ where: { id: existing.id }, include: PO_INCLUDE })
  res.json(toPurchaseOrderJson(updated))
})

/**
 * POST /:poId/receive — record a goods receipt (PUR-02).
 *
 * Partial receipt is the normal case: the request names only the lines that
 * actually arrived, with only the quantities that arrived. Everything that
 * follows from a receipt — the moving-average cost update, the `receive` stock
 * movement, the line's running total, and the PO's derived status — is done by
 * 0021's `apply_purchase_receipt_line` trigger, so a caller cannot get the
 * ordering wrong.
 *
 * Idempotency is the (tenant_id, client_receipt_id) unique index, not this
 * route's pre-check: a replayed request returns the ORIGINAL receipt and
 * changes nothing.
 */
router.post('/:poId/receive', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.poId).success) {
    return res.status(400).json({ error: 'Invalid purchase order id' })
  }
  const parsed = ReceivePurchaseOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' })

  const tenantId = req.user!.tenantId

  try {
    const result = await forTenantTransaction(tenantId, async (tx) => {
      const po = await tx.purchase_orders.findFirst({ where: { id: req.params.poId } })
      if (!po) throw Object.assign(new Error('Purchase order not found'), { status: 404 })
      if (po.status === 'cancelled') {
        throw Object.assign(new Error('A cancelled purchase order cannot be received'), { status: 409 })
      }
      if (po.status === 'draft') {
        throw Object.assign(new Error('Send this purchase order before receiving against it'), { status: 409 })
      }

      const existingReceipt = await tx.purchase_order_receipts.findFirst({
        where: { client_receipt_id: parsed.data.clientReceiptId },
      })
      if (existingReceipt) return { receiptId: existingReceipt.id, replayed: true, overReceived: [] as any[] }

      const lineIds = parsed.data.lines.map((l) => l.purchaseOrderLineId)
      if (new Set(lineIds).size !== lineIds.length) {
        throw Object.assign(new Error('A line can appear only once per receipt'), { status: 400 })
      }

      const poLines = await tx.purchase_order_lines.findMany({
        where: { id: { in: lineIds }, purchase_order_id: po.id },
        include: { variants: true },
      })
      if (poLines.length !== lineIds.length) {
        throw Object.assign(new Error('One or more lines do not belong to this purchase order'), { status: 400 })
      }

      const receipt = await tx.purchase_order_receipts.create({
        data: {
          tenant_id: tenantId,
          purchase_order_id: po.id,
          client_receipt_id: parsed.data.clientReceiptId,
          note: parsed.data.note ?? null,
        },
      })

      const overReceived: any[] = []
      for (const input of parsed.data.lines) {
        const poLine = poLines.find((l: any) => l.id === input.purchaseOrderLineId)!
        await tx.purchase_order_receipt_lines.create({
          data: {
            tenant_id: tenantId,
            receipt_id: receipt.id,
            purchase_order_line_id: poLine.id,
            variant_id: poLine.variant_id,
            quantity_received: input.quantityReceived,
            unit_cost: input.unitCost ?? poLine.unit_cost,
          },
        })

        // Over-receipt is allowed — the goods physically arrived — but is
        // reported back rather than silently accepted.
        // quantity_received is a Prisma Decimal since 0031 — `+` on it would
        // concatenate strings rather than add, so coerce before arithmetic.
        const receivedAfter = Number(poLine.quantity_received) + input.quantityReceived
        if (receivedAfter > Number(poLine.quantity_ordered)) {
          overReceived.push({
            purchaseOrderLineId: poLine.id,
            sku: poLine.variants?.sku ?? '',
            quantityOrdered: Number(poLine.quantity_ordered),
            quantityReceived: receivedAfter,
          })
        }
      }

      return { receiptId: receipt.id, replayed: false, overReceived }
    })

    const client = forTenant(tenantId) as any
    const po = await client.purchase_orders.findFirst({ where: { id: req.params.poId }, include: PO_INCLUDE })

    return res.status(result.replayed ? 200 : 201).json({
      receiptId: result.receiptId,
      replayed: result.replayed,
      overReceived: result.overReceived,
      purchaseOrder: toPurchaseOrderJson(po),
    })
  } catch (err: any) {
    // A concurrent replay loses the race to the unique index rather than the
    // pre-check above — same outcome, surfaced as a conflict.
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'This receipt has already been recorded' })
    }
    const status = Number.isInteger(err?.status) ? err.status : 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not record this receipt' : err.message ?? 'Could not record this receipt',
    })
  }
})

export default router
