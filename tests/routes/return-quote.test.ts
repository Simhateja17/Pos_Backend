import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  scope: vi.fn(),
  sale: vi.fn(),
  invoice: vi.fn(),
  creditNotes: vi.fn(),
  tenant: vi.fn(),
  saleLines: vi.fn(),
  invoiceLines: vi.fn(),
  movements: vi.fn(),
  payments: vi.fn(),
  previewTaxInvoice: vi.fn(),
}))
vi.mock('../../src/db/tenantClient', () => ({ forTenantTransaction: mocks.transaction, forTenant: vi.fn() }))
vi.mock('../../src/middleware/storeContext', () => ({ activeStoreId: mocks.scope }))
vi.mock('../../src/services/taxDocuments', () => ({
  createCreditNoteForReturn: vi.fn(),
  ensureTaxInvoice: vi.fn(),
  lockTaxInvoiceSale: vi.fn(),
  previewTaxInvoice: mocks.previewTaxInvoice,
}))

import returnsRouter from '../../src/routes/returns'
import { ReturnQuoteSchema } from '../../src/contracts/schemas/return'

const saleId = '11111111-1111-4111-8111-111111111111'
const lineId = '22222222-2222-4222-8222-222222222222'
const secondLineId = '77777777-7777-4777-8777-777777777777'
const variantId = '33333333-3333-4333-8333-333333333333'
const storeId = '44444444-4444-4444-8444-444444444444'
const invoiceId = '55555555-5555-4555-8555-555555555555'
const client = {
  sales: { findFirst: mocks.sale },
  tax_documents: { findFirst: mocks.invoice, findMany: mocks.creditNotes },
  tenants: { findFirst: mocks.tenant },
  sale_line_items: { findMany: mocks.saleLines },
  tax_document_lines: { findMany: mocks.invoiceLines },
  stock_movements: { findMany: mocks.movements },
  payments: { findMany: mocks.payments },
}
const app = express()
  .use(express.json())
  .use((req, _res, next) => { req.user = { tenantId: 'tenant-a' } as any; next() })
  .use('/returns', returnsRouter)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope.mockReturnValue(storeId)
  mocks.transaction.mockImplementation(async (_tenant, action) => action(client))
  mocks.sale.mockResolvedValue({ id: saleId, store_id: storeId, status: 'completed' })
  mocks.invoice.mockResolvedValue({ id: invoiceId })
  mocks.creditNotes.mockResolvedValue([{ id: '66666666-6666-4666-8666-666666666666' }])
  mocks.tenant.mockResolvedValue({ country: 'IN' })
  mocks.saleLines.mockResolvedValue([{
    id: lineId,
    variant_id: variantId,
    quantity: new Prisma.Decimal('2'),
    variants: { products: { name: 'Measured item' } },
  }])
  mocks.invoiceLines.mockImplementation(async ({ where }: any) =>
    where.document_id?.in
      ? [{ sale_line_item_id: lineId, quantity: new Prisma.Decimal('0.5') }]
      : [{
          sale_line_item_id: lineId,
          quantity: new Prisma.Decimal('2'),
          line_total: new Prisma.Decimal('23.00'),
        }],
  )
  mocks.movements.mockResolvedValue([{ quantity_delta: new Prisma.Decimal('0.5') }])
  mocks.payments.mockResolvedValue([{ method: 'cash', amount: new Prisma.Decimal('23.00'), created_at: new Date() }])
  mocks.previewTaxInvoice.mockResolvedValue({ lines: [{ saleLineItemId: lineId, quantity: '2', lineTotal: '23.00' }] })
})

describe('read-only return quote', () => {
  it('returns remaining quantity, exact refund and original tenders without writes', async () => {
    const response = await request(app).post('/returns/quote').send({ saleId, lines: [{ saleLineItemId: lineId, quantity: 1 }] })
    expect(response.status).toBe(200)
    expect(ReturnQuoteSchema.parse(response.body)).toMatchObject({
      saleId, storeId, currency: 'INR', refundTotal: '11.50',
      lines: [{ saleLineItemId: lineId, variantId, requestedQuantity: 1, remainingQuantity: 1.5, refundAmount: '11.50' }],
      originalPayments: [{ method: 'cash', amount: '23.00' }],
    })
    expect(mocks.transaction).toHaveBeenCalledWith('tenant-a', expect.any(Function))
  })

  it('rejects an over-return before producing a refund total', async () => {
    const response = await request(app).post('/returns/quote').send({ saleId, lines: [{ saleLineItemId: lineId, quantity: 2 }] })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('OVER_RETURN')
  })

  it('tracks prior returns by sale line when two lines use the same variant', async () => {
    mocks.saleLines.mockResolvedValue([
      {
        id: lineId, variant_id: variantId, quantity: new Prisma.Decimal('2'),
        variants: { products: { name: 'First priced line' } },
      },
      {
        id: secondLineId, variant_id: variantId, quantity: new Prisma.Decimal('2'),
        variants: { products: { name: 'Second priced line' } },
      },
    ])
    mocks.invoiceLines.mockImplementation(async ({ where }: any) =>
      where.document_id?.in
        ? [{ sale_line_item_id: lineId, quantity: new Prisma.Decimal('0.5') }]
        : [
            { sale_line_item_id: lineId, quantity: new Prisma.Decimal('2'), line_total: new Prisma.Decimal('23.00') },
            { sale_line_item_id: secondLineId, quantity: new Prisma.Decimal('2'), line_total: new Prisma.Decimal('40.00') },
          ],
    )

    const response = await request(app).post('/returns/quote').send({
      saleId,
      lines: [{ saleLineItemId: secondLineId, quantity: 2 }],
    })

    expect(response.status).toBe(200)
    expect(response.body.lines).toEqual([
      expect.objectContaining({ saleLineItemId: secondLineId, remainingQuantity: 2, refundAmount: '40.00' }),
    ])
  })

  it('rejects fractional returns for discrete piece variants', async () => {
    const response = await request(app).post('/returns/quote').send({ saleId, lines: [{ saleLineItemId: lineId, quantity: 0.5 }] })
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('INVALID_QUANTITY')
    expect(mocks.creditNotes).not.toHaveBeenCalled()
  })

  it('uses a pure tax preview when a persisted snapshot is missing, without allocating one', async () => {
    mocks.invoice.mockResolvedValue(null)
    const response = await request(app).post('/returns/quote').send({ saleId, lines: [{ saleLineItemId: lineId, quantity: 1 }] })
    expect(response.status).toBe(200)
    expect(response.body.refundTotal).toBe('11.50')
    expect(mocks.previewTaxInvoice).toHaveBeenCalledWith(client, 'tenant-a', saleId)
    expect(mocks.invoiceLines.mock.calls.some(([args]) => args.where.document_id === invoiceId)).toBe(false)
  })

  it('reports only the amount still refundable on each original tender', async () => {
    mocks.payments.mockResolvedValue([
      { method: 'cash', direction: 'payment', amount: new Prisma.Decimal('20.00'), created_at: new Date() },
      { method: 'card', direction: 'payment', amount: new Prisma.Decimal('10.00'), created_at: new Date() },
      { method: 'cash', direction: 'refund', amount: new Prisma.Decimal('5.00'), created_at: new Date() },
    ])

    const response = await request(app).post('/returns/quote').send({ saleId, lines: [{ saleLineItemId: lineId, quantity: 1 }] })

    expect(response.status).toBe(200)
    expect(response.body.originalPayments).toEqual([
      { method: 'cash', amount: '15.00' },
      { method: 'card', amount: '10.00' },
    ])
  })
})
