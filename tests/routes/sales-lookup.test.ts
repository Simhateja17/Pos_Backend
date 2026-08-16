import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const salesFindFirstMock = vi.fn()
const salesFindManyMock = vi.fn()
const taxDocumentsFindFirstMock = vi.fn()
const customersFindManyMock = vi.fn()
const saleLineItemsFindManyMock = vi.fn()
const paymentsFindManyMock = vi.fn()

const client = {
  sales: { findFirst: salesFindFirstMock, findMany: salesFindManyMock },
  tax_documents: { findFirst: taxDocumentsFindFirstMock },
  customers: { findMany: customersFindManyMock },
  sale_line_items: { findMany: saleLineItemsFindManyMock },
  payments: { findMany: paymentsFindManyMock },
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => client),
  forTenantTransaction: vi.fn(),
}))

vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(),
}))

vi.mock('../../src/services/email', () => ({
  sendLoggedEmail: vi.fn(),
}))

const saleId = 'dcfb11a0-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'

function decimal(value: string) {
  return { toString: () => value }
}

function saleRow() {
  return {
    id: saleId,
    client_sale_id: '31111111-1111-4111-8111-111111111111',
    shift_id: '41111111-1111-4111-8111-111111111111',
    customer_id: customerId,
    subtotal: decimal('100.00'),
    discount_amount: decimal('0.00'),
    tax_amount: decimal('18.00'),
    total_amount: decimal('118.00'),
    status: 'completed',
    created_by: null,
    created_at: new Date('2026-08-15T10:00:00.000Z'),
  }
}

function buildApp(role: 'owner' | 'cashier' = 'owner') {
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', role, tenantId: 'tenant-1', storeId: 'store-1' }
    next()
  })
  return import('../../src/routes/sales').then(({ default: salesRouter }) => {
    app.use('/sales', salesRouter)
    return app
  })
}

describe('returns sale lookup', () => {
  beforeEach(() => {
    vi.resetModules()
    salesFindFirstMock.mockReset().mockResolvedValue(null)
    salesFindManyMock.mockReset().mockResolvedValue([])
    taxDocumentsFindFirstMock.mockReset().mockResolvedValue(null)
    customersFindManyMock.mockReset().mockResolvedValue([])
    saleLineItemsFindManyMock.mockReset().mockResolvedValue([])
    paymentsFindManyMock.mockReset().mockResolvedValue([])
  })

  it('treats a human receipt value as a document lookup instead of rejecting it as a UUID', async () => {
    const app = await buildApp()
    const response = await request(app).get('/sales').query({ receiptNumber: 'df' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual([])
    expect(taxDocumentsFindFirstMock).toHaveBeenCalledWith({
      where: {
        document_type: 'tax_invoice',
        document_number: { equals: 'df', mode: 'insensitive' },
      },
      select: { sale_id: true },
    })
    expect(salesFindFirstMock).not.toHaveBeenCalled()
  })

  it('resolves the live human tax invoice number to its sale', async () => {
    const app = await buildApp()
    const row = saleRow()
    taxDocumentsFindFirstMock.mockResolvedValue({ sale_id: saleId })
    salesFindFirstMock.mockResolvedValue(row)
    saleLineItemsFindManyMock.mockResolvedValue([{
      id: '51111111-1111-4111-8111-111111111111',
      variant_id: '61111111-1111-4111-8111-111111111111',
      quantity: 1,
      unit_price: decimal('100.00'),
      discount_percent: null,
      discount_amount: decimal('0.00'),
      is_taxable: true,
      line_total: decimal('118.00'),
    }])
    paymentsFindManyMock.mockResolvedValue([{
      id: '71111111-1111-4111-8111-111111111111',
      sale_id: saleId,
      method: 'cash',
      direction: 'payment',
      amount: decimal('118.00'),
      reference_code: null,
      created_by: null,
      created_at: new Date('2026-08-15T10:00:00.000Z'),
    }])

    const response = await request(app).get('/sales').query({ receiptNumber: 'q9-202627-0003' })

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1)
    expect(response.body[0]).toMatchObject({ id: saleId, totalAmount: '118.00' })
    expect(salesFindFirstMock).toHaveBeenCalledWith({ where: { id: saleId } })
  })

  it('resolves the short sale-id reference shown by Sales/Bills', async () => {
    const app = await buildApp()
    salesFindManyMock.mockResolvedValue([saleRow()])

    const response = await request(app).get('/sales').query({ receiptNumber: 'DCFB11A0' })

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1)
    expect(response.body[0].id).toBe(saleId)
    expect(salesFindManyMock).toHaveBeenCalledWith({
      where: {
        id: {
          gte: 'dcfb11a0-0000-0000-0000-000000000000',
          lte: 'dcfb11a0-ffff-ffff-ffff-ffffffffffff',
        },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    })
    expect(taxDocumentsFindFirstMock).toHaveBeenCalledWith({
      where: {
        document_type: 'tax_invoice',
        document_number: { equals: 'DCFB11A0', mode: 'insensitive' },
      },
      select: { sale_id: true },
    })
  })

  it('keeps customer-name search working for cashier returns lookups', async () => {
    const app = await buildApp('cashier')
    salesFindManyMock.mockResolvedValue([saleRow()])
    customersFindManyMock.mockResolvedValue([{
      id: customerId,
      name: 'Asha Rao',
      billing_name: 'Asha Rao',
      phone: '+919870000002',
      email: 'asha@example.test',
      created_at: new Date('2026-08-15T09:00:00.000Z'),
    }])

    const response = await request(app).get('/sales').query({ customerSearch: 'Asha' })

    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1)
    expect(customersFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: expect.any(Array) },
    }))
    expect(response.body[0].id).toBe(saleId)
  })

  it('keeps legacy sale UUID lookup working', async () => {
    const app = await buildApp()
    salesFindFirstMock.mockResolvedValue(saleRow())

    const response = await request(app).get('/sales').query({ receiptNumber: saleId })

    expect(response.status).toBe(200)
    expect(response.body[0].id).toBe(saleId)
    expect(taxDocumentsFindFirstMock).not.toHaveBeenCalled()
  })
})
