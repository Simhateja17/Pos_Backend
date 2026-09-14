import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const shiftsFindFirstMock = vi.fn()
const salesFindFirstMock = vi.fn()
const saleLineItemsFindFirstMock = vi.fn()
const lockTaxInvoiceSaleMock = vi.fn()
const taxDocumentsFindFirstMock = vi.fn()
const taxDocumentsFindManyMock = vi.fn()
const taxDocumentLinesFindManyMock = vi.fn()
const paymentsFindManyMock = vi.fn()
const paymentsCreateMock = vi.fn()
const stockMovementCreateMock = vi.fn()
const creditCreateMock = vi.fn()
const staffFindFirstMock = vi.fn()
const createCreditNoteForReturnMock = vi.fn()

const tx = {
  shifts: { findFirst: shiftsFindFirstMock },
  sales: { findFirst: salesFindFirstMock },
  tenants: { findFirst: vi.fn(async () => ({ country: 'IN' })) },
  tax_documents: { findFirst: taxDocumentsFindFirstMock, findMany: taxDocumentsFindManyMock },
  tax_document_lines: { findMany: taxDocumentLinesFindManyMock },
  sale_line_items: { findFirst: saleLineItemsFindFirstMock },
  payments: { findMany: paymentsFindManyMock, create: paymentsCreateMock },
  stock_movements: { create: stockMovementCreateMock },
  customer_credit_transactions: { create: creditCreateMock },
  staff_members: { findFirst: staffFindFirstMock },
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => tx),
  forTenantTransaction: vi.fn(async (_tenantId: string, action: (client: typeof tx) => Promise<unknown>) => action(tx)),
}))

vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(async () => null),
}))

vi.mock('../../src/services/taxDocuments', () => ({
  createCreditNoteForReturn: createCreditNoteForReturnMock,
  ensureTaxInvoice: vi.fn(),
  lockTaxInvoiceSale: lockTaxInvoiceSaleMock,
  previewTaxInvoice: vi.fn(async () => ({ lines: [] })),
}))

describe('return submission store scope', () => {
  beforeEach(() => {
    shiftsFindFirstMock.mockReset().mockResolvedValue({
      id: '21111111-1111-4111-8111-111111111111',
      store_id: 'store-s2',
      terminal_id: null,
      closed_at: null,
    })
    salesFindFirstMock.mockReset().mockResolvedValue(null)
    saleLineItemsFindFirstMock.mockReset().mockResolvedValue(null)
    lockTaxInvoiceSaleMock.mockReset().mockResolvedValue('31111111-1111-4111-8111-111111111111')
    taxDocumentsFindFirstMock.mockReset().mockResolvedValue(null)
    taxDocumentsFindManyMock.mockReset().mockResolvedValue([])
    taxDocumentLinesFindManyMock.mockReset().mockResolvedValue([])
    paymentsFindManyMock.mockReset().mockResolvedValue([])
    paymentsCreateMock.mockReset()
    stockMovementCreateMock.mockReset()
    creditCreateMock.mockReset()
    staffFindFirstMock.mockReset().mockResolvedValue({ id: '61111111-1111-4111-8111-111111111111' })
    createCreditNoteForReturnMock.mockReset()
  })

  it('returns a complete operator-scoped recovery response', async () => {
    taxDocumentsFindFirstMock.mockResolvedValue({
      id: '51111111-1111-4111-8111-111111111111',
      sale_id: '31111111-1111-4111-8111-111111111111',
      grand_total: { toString: () => '35.00' },
      document_number: 'CN-1',
      payment_snapshot: [{ method: 'cash', amount: '35.00', referenceCode: null }],
    })
    taxDocumentLinesFindManyMock.mockResolvedValue([{
      sale_line_item_id: '41111111-1111-4111-8111-111111111111',
      quantity: { toString: () => '1' },
      line_total: { toString: () => '35.00' },
    }])

    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).get('/returns/recovery/11111111-1111-4111-8111-111111111111')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      returnReferenceId: '11111111-1111-4111-8111-111111111111',
      refundTotal: '35.00',
      refundPayments: [{ method: 'cash', amount: '35.00', referenceCode: null }],
      refundedLines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1, refundAmount: '35.00' }],
    })
    expect(taxDocumentsFindFirstMock).toHaveBeenCalledWith({ where: expect.objectContaining({
      store_id: 'store-s2', created_by: '61111111-1111-4111-8111-111111111111',
    }) })
  })

  it('uses scoped 404 to prove a return reference was not committed', async () => {
    taxDocumentsFindFirstMock.mockResolvedValue(null)
    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).get('/returns/recovery/11111111-1111-4111-8111-111111111111')
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('OPERATION_NOT_COMMITTED')
  })

  it('does not resolve a sale from another store', async () => {
    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).post('/returns').send({
      returnReferenceId: '11111111-1111-4111-8111-111111111111',
      saleId: '31111111-1111-4111-8111-111111111111',
      shiftId: '21111111-1111-4111-8111-111111111111',
      reason: 'Wrong size',
      lines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1 }],
      refundPayments: [{ method: 'cash', amount: '118.00' }],
    })

    expect(response.status).toBe(404)
    expect(salesFindFirstMock).toHaveBeenCalledWith({
      where: { id: '31111111-1111-4111-8111-111111111111', store_id: 'store-s2' },
    })
  })

  it('uses the privileged tenant-checked lock instead of locking sales directly', async () => {
    salesFindFirstMock.mockResolvedValue({ id: '31111111-1111-4111-8111-111111111111', status: 'completed' })

    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).post('/returns').send({
      returnReferenceId: '11111111-1111-4111-8111-111111111111',
      saleId: '31111111-1111-4111-8111-111111111111',
      shiftId: '21111111-1111-4111-8111-111111111111',
      reason: 'Damaged or defective item',
      lines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1 }],
      refundPayments: [{ method: 'credit', amount: '35.00' }],
    })

    expect(response.status).toBe(404)
    expect(lockTaxInvoiceSaleMock).toHaveBeenCalledWith(
      tx,
      'tenant-1',
      '31111111-1111-4111-8111-111111111111',
    )
    expect(saleLineItemsFindFirstMock).toHaveBeenCalled()
  })

  it('rejects changed return data when the return reference already exists', async () => {
    const saleId = '31111111-1111-4111-8111-111111111111'
    salesFindFirstMock.mockResolvedValue({ id: saleId, status: 'completed' })
    taxDocumentsFindFirstMock.mockResolvedValueOnce({
      id: '51111111-1111-4111-8111-111111111111',
      sale_id: saleId,
      created_by: '61111111-1111-4111-8111-111111111111',
      request_hash: '0'.repeat(64),
    })

    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).post('/returns').send({
      returnReferenceId: '11111111-1111-4111-8111-111111111111',
      saleId,
      shiftId: '21111111-1111-4111-8111-111111111111',
      reason: 'Changed return data',
      lines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1 }],
      refundPayments: [{ method: 'cash', amount: '35.00' }],
    })

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(saleLineItemsFindFirstMock).not.toHaveBeenCalled()
  })

  it('refuses idempotent replay under a different operator', async () => {
    const saleId = '31111111-1111-4111-8111-111111111111'
    salesFindFirstMock.mockResolvedValue({ id: saleId, status: 'completed' })
    taxDocumentsFindFirstMock.mockResolvedValueOnce({
      id: '51111111-1111-4111-8111-111111111111', sale_id: saleId,
      created_by: 'different-operator', request_hash: null,
    })
    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)
    const response = await request(app).post('/returns').send({
      returnReferenceId: '11111111-1111-4111-8111-111111111111', saleId,
      shiftId: '21111111-1111-4111-8111-111111111111', reason: 'Wrong size',
      lines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1 }],
      refundPayments: [{ method: 'cash', amount: '35.00' }],
    })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(saleLineItemsFindFirstMock).not.toHaveBeenCalled()
  })

  it('rejects a return when the original sale is not completed', async () => {
    salesFindFirstMock.mockResolvedValue({
      id: '31111111-1111-4111-8111-111111111111',
      status: 'voided',
    })

    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).post('/returns').send({
      returnReferenceId: '11111111-1111-4111-8111-111111111111',
      saleId: '31111111-1111-4111-8111-111111111111',
      shiftId: '21111111-1111-4111-8111-111111111111',
      reason: 'Invalid sale state',
      lines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1 }],
      refundPayments: [{ method: 'cash', amount: '35.00' }],
    })

    expect(response.status).toBe(409)
    expect(response.body.code).toBe('SALE_NOT_RETURNABLE')
    expect(lockTaxInvoiceSaleMock).not.toHaveBeenCalled()
  })

  it('appends one idempotently referenced credit-refund ledger row', async () => {
    const saleId = '31111111-1111-4111-8111-111111111111'
    const lineId = '41111111-1111-4111-8111-111111111111'
    const returnReferenceId = '11111111-1111-4111-8111-111111111111'
    salesFindFirstMock.mockResolvedValue({
      id: saleId,
      store_id: 'store-s2',
      customer_id: '71111111-1111-4111-8111-111111111111',
      status: 'completed',
    })
    taxDocumentsFindFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: '51111111-1111-4111-8111-111111111111' })
    saleLineItemsFindFirstMock.mockResolvedValue({
      id: lineId,
      sale_id: saleId,
      variant_id: '81111111-1111-4111-8111-111111111111',
      quantity: 1,
      variants: { unit_of_measure: 'piece' },
    })
    taxDocumentLinesFindManyMock.mockResolvedValue([{
      sale_line_item_id: lineId,
      quantity: 1,
      line_total: 35,
    }])
    paymentsFindManyMock.mockImplementation(async ({ where }: any) =>
      where.direction === 'payment' ? [{ method: 'credit', direction: 'payment', amount: 35 }] : [],
    )
    stockMovementCreateMock.mockResolvedValue({ id: 'movement-1' })
    paymentsCreateMock.mockResolvedValue({
      id: 'payment-1', method: 'credit', direction: 'refund', amount: 35, reference_code: null,
    })
    creditCreateMock.mockResolvedValue({ id: 'credit-refund-1' })
    createCreditNoteForReturnMock.mockResolvedValue({
      document: { id: '91111111-1111-4111-8111-111111111111', documentNumber: 'CN-1' },
    })

    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).post('/returns').send({
      returnReferenceId,
      saleId,
      shiftId: '21111111-1111-4111-8111-111111111111',
      reason: 'Customer return',
      lines: [{ saleLineItemId: lineId, quantity: 1 }],
      refundPayments: [{ method: 'credit', amount: '35.00' }],
    })

    expect(response.status).toBe(201)
    expect(creditCreateMock).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: 'credit_refund',
      amount: '35.00',
      sale_id: saleId,
      return_reference_id: returnReferenceId,
    }) })
  })
})
