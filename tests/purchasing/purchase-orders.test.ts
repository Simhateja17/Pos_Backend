import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const poFindFirstMock = vi.fn()
const poFindManyMock = vi.fn()
const poCreateMock = vi.fn()
const poUpdateMock = vi.fn()
const poCountMock = vi.fn()
const lineFindManyMock = vi.fn()
const lineCreateMock = vi.fn()
const receiptFindFirstMock = vi.fn()
const receiptCreateMock = vi.fn()
const receiptLineCreateMock = vi.fn()
const supplierFindFirstMock = vi.fn()
const variantFindManyMock = vi.fn()

const txClient = {
  purchase_orders: {
    findFirst: poFindFirstMock,
    findMany: poFindManyMock,
    create: poCreateMock,
    update: poUpdateMock,
    count: poCountMock,
  },
  purchase_order_lines: { findMany: lineFindManyMock, create: lineCreateMock },
  purchase_order_receipts: { findFirst: receiptFindFirstMock, create: receiptCreateMock },
  purchase_order_receipt_lines: { create: receiptLineCreateMock },
  suppliers: { findFirst: supplierFindFirstMock },
  variants: { findMany: variantFindManyMock },
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => txClient),
  forTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) => fn(txClient)),
}))

function tokenFor(tenantId = 'tenant-abc') {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', role: 'owner', tenant_id: tenantId })}.sig`
}

const PO_ID = '22222222-2222-4222-8222-222222222222'
const LINE_ID = '33333333-3333-4333-8333-333333333333'
const VARIANT_ID = '44444444-4444-4444-8444-444444444444'
const RECEIPT_KEY = '55555555-5555-4555-8555-555555555555'

const poRow = {
  id: PO_ID,
  po_number: 'PO-0001',
  supplier_id: '66666666-6666-4666-8666-666666666666',
  status: 'sent',
  expected_date: null,
  notes: null,
  created_at: new Date('2026-05-01T00:00:00Z'),
  suppliers: { name: 'Fabindia Mills' },
  purchase_order_lines: [
    {
      id: LINE_ID,
      variant_id: VARIANT_ID,
      quantity_ordered: 100,
      quantity_received: 40,
      unit_cost: { toString: () => '520.00' },
      variants: { sku: 'SKU-1', products: { name: 'Kurta' } },
    },
  ],
}

describe('purchase order routes', () => {
  beforeEach(() => {
    for (const m of [
      poFindFirstMock, poFindManyMock, poCreateMock, poUpdateMock, poCountMock,
      lineFindManyMock, lineCreateMock, receiptFindFirstMock, receiptCreateMock,
      receiptLineCreateMock, supplierFindFirstMock, variantFindManyMock,
    ]) m.mockReset()
  })

  async function buildApp() {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '')
      if (token) {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
        ;(req as any).user = { tenantId: payload.tenant_id, role: payload.role }
      }
      next()
    })
    const { default: router } = await import('../../src/routes/purchase-orders')
    app.use('/purchase-orders', router)
    return app
  }

  it('Test 1: POST / rejects the same variant appearing twice on one order', async () => {
    const app = await buildApp()
    const res = await request(app)
      .post('/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        supplierId: '66666666-6666-4666-8666-666666666666',
        lines: [
          { variantId: VARIANT_ID, quantityOrdered: 5, unitCost: 100 },
          { variantId: VARIANT_ID, quantityOrdered: 3, unitCost: 100 },
        ],
      })

    expect(res.status).toBe(400)
    expect(poCreateMock).not.toHaveBeenCalled()
  })

  it('Test 2: POST /:poId/receive on a DRAFT order is refused — you cannot receive what was never sent', async () => {
    poFindFirstMock.mockResolvedValue({ ...poRow, status: 'draft' })
    const app = await buildApp()

    const res = await request(app)
      .post(`/purchase-orders/${PO_ID}/receive`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ clientReceiptId: RECEIPT_KEY, lines: [{ purchaseOrderLineId: LINE_ID, quantityReceived: 10 }] })

    expect(res.status).toBe(409)
    expect(receiptCreateMock).not.toHaveBeenCalled()
  })

  it('Test 3: a partial receipt writes a receipt line for only the quantity that arrived', async () => {
    poFindFirstMock.mockResolvedValue(poRow)
    receiptFindFirstMock.mockResolvedValue(null)
    lineFindManyMock.mockResolvedValue([poRow.purchase_order_lines[0]])
    receiptCreateMock.mockResolvedValue({ id: 'receipt-1' })
    receiptLineCreateMock.mockResolvedValue({})

    const app = await buildApp()
    const res = await request(app)
      .post(`/purchase-orders/${PO_ID}/receive`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ clientReceiptId: RECEIPT_KEY, lines: [{ purchaseOrderLineId: LINE_ID, quantityReceived: 25 }] })

    expect(res.status).toBe(201)
    expect(res.body.replayed).toBe(false)
    expect(receiptLineCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantity_received: 25 }) }),
    )
    // Cost falls back to the line's ordered unit cost when the delivery
    // charged what the PO expected.
    expect(receiptLineCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unit_cost: poRow.purchase_order_lines[0].unit_cost }) }),
    )
  })

  it('Test 4: replaying the same clientReceiptId returns the original receipt and writes nothing', async () => {
    poFindFirstMock.mockResolvedValue(poRow)
    receiptFindFirstMock.mockResolvedValue({ id: 'receipt-original' })

    const app = await buildApp()
    const res = await request(app)
      .post(`/purchase-orders/${PO_ID}/receive`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ clientReceiptId: RECEIPT_KEY, lines: [{ purchaseOrderLineId: LINE_ID, quantityReceived: 25 }] })

    expect(res.status).toBe(200)
    expect(res.body.replayed).toBe(true)
    expect(res.body.receiptId).toBe('receipt-original')
    expect(receiptCreateMock).not.toHaveBeenCalled()
    expect(receiptLineCreateMock).not.toHaveBeenCalled()
  })

  it('Test 5: over-receipt is accepted but reported in overReceived, not silently swallowed', async () => {
    poFindFirstMock.mockResolvedValue(poRow)
    receiptFindFirstMock.mockResolvedValue(null)
    lineFindManyMock.mockResolvedValue([poRow.purchase_order_lines[0]])
    receiptCreateMock.mockResolvedValue({ id: 'receipt-2' })
    receiptLineCreateMock.mockResolvedValue({})

    const app = await buildApp()
    // 40 already received against 100 ordered; receiving 70 more = 110 > 100.
    const res = await request(app)
      .post(`/purchase-orders/${PO_ID}/receive`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ clientReceiptId: RECEIPT_KEY, lines: [{ purchaseOrderLineId: LINE_ID, quantityReceived: 70 }] })

    expect(res.status).toBe(201)
    expect(receiptLineCreateMock).toHaveBeenCalled()
    expect(res.body.overReceived).toEqual([
      { purchaseOrderLineId: LINE_ID, sku: 'SKU-1', quantityOrdered: 100, quantityReceived: 110 },
    ])
  })

  it('Test 6: a receipt naming a line from another purchase order is refused', async () => {
    poFindFirstMock.mockResolvedValue(poRow)
    receiptFindFirstMock.mockResolvedValue(null)
    lineFindManyMock.mockResolvedValue([]) // scoped query finds nothing for this PO
    receiptCreateMock.mockResolvedValue({ id: 'receipt-3' })

    const app = await buildApp()
    const res = await request(app)
      .post(`/purchase-orders/${PO_ID}/receive`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ clientReceiptId: RECEIPT_KEY, lines: [{ purchaseOrderLineId: LINE_ID, quantityReceived: 5 }] })

    expect(res.status).toBe(400)
    expect(receiptCreateMock).not.toHaveBeenCalled()
  })

  it('Test 7: PATCH cannot set a derived status — partial/received come only from the receipt trigger', async () => {
    const app = await buildApp()
    const res = await request(app)
      .patch(`/purchase-orders/${PO_ID}`)
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ status: 'received' })

    expect(res.status).toBe(400)
    expect(poUpdateMock).not.toHaveBeenCalled()
  })
})
