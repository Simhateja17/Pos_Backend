import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const salesFindFirstMock = vi.fn()
const salesCreateMock = vi.fn()
const shiftsFindFirstMock = vi.fn()
const variantsFindFirstMock = vi.fn()
const tenantsFindFirstMock = vi.fn()
const storesFindFirstMock = vi.fn()
const variantStockFindFirstMock = vi.fn()
const customersFindFirstMock = vi.fn()
const customersFindManyMock = vi.fn()
const staffFindManyMock = vi.fn()
const staffFindFirstMock = vi.fn()
const saleLinesCreateMock = vi.fn()
const paymentsCreateMock = vi.fn()
const creditCreateMock = vi.fn()
const stockCreateMock = vi.fn()
const creditGroupByMock = vi.fn()
const queryRawMock = vi.fn()
const effectivePricesMock = vi.fn()

const customerId = '11111111-1111-4111-8111-111111111111'
const variantId = '22222222-2222-4222-8222-222222222222'
const shiftId = '33333333-3333-4333-8333-333333333333'
const saleId = '44444444-4444-4444-8444-444444444444'
const staffId = '55555555-5555-4555-8555-555555555555'
const storeId = '66666666-6666-4666-8666-666666666666'

const client = {
  sales: { findFirst: salesFindFirstMock, create: salesCreateMock },
  shifts: { findFirst: shiftsFindFirstMock },
  variants: { findFirst: variantsFindFirstMock },
  tenants: { findFirst: tenantsFindFirstMock },
  stores: { findFirst: storesFindFirstMock },
  variant_stock_levels: { findFirst: variantStockFindFirstMock },
  customers: { findFirst: customersFindFirstMock, findMany: customersFindManyMock },
  staff_members: { findFirst: staffFindFirstMock, findMany: staffFindManyMock },
  sale_line_items: { create: saleLinesCreateMock },
  payments: { create: paymentsCreateMock },
  customer_credit_transactions: { create: creditCreateMock, groupBy: creditGroupByMock },
  stock_movements: { create: stockCreateMock },
  $queryRaw: queryRawMock,
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => client),
  forTenantTransaction: vi.fn(async (_tenantId: string, callback: (tx: any) => Promise<unknown>) => callback(client)),
}))

vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(async () => ({ id: 'counter-1' })),
}))

vi.mock('../../src/lib/storePricing', () => ({
  effectivePricesForVariants: (...args: unknown[]) => effectivePricesMock(...args),
}))

vi.mock('../../src/services/taxDocuments', () => ({
  ensureTaxInvoice: vi.fn(async () => null),
}))

vi.mock('../../src/services/email', () => ({
  sendLoggedEmail: vi.fn(async () => ({ status: 'sent' })),
}))

function customerRow() {
  return {
    id: customerId,
    tenant_id: 'tenant-a',
    name: 'Asha Rao',
    billing_name: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@example.com',
  }
}

function saleRow(data: any) {
  return {
    ...data,
    id: saleId,
    subtotal: new Prisma.Decimal(data.subtotal),
    discount_amount: new Prisma.Decimal(data.discount_amount),
    tax_amount: new Prisma.Decimal(data.tax_amount),
    total_amount: new Prisma.Decimal(data.total_amount),
    cash_received: data.cash_received === null ? null : new Prisma.Decimal(data.cash_received),
    change_due: new Prisma.Decimal(data.change_due),
    created_at: new Date('2026-08-10T10:00:00.000Z'),
  }
}

function resetTransactionMocks() {
  salesFindFirstMock.mockResolvedValue(null)
  shiftsFindFirstMock.mockResolvedValue({ id: shiftId, closed_at: null, terminal_id: null })
  variantsFindFirstMock.mockResolvedValue({
    id: variantId,
    unit_of_measure: 'piece',
    is_taxable: true,
    tax_rate: new Prisma.Decimal('0.18'),
    track_inventory: false,
    allow_negative_stock: false,
    products: { name: 'Cotton shirt', is_active: true },
  })
  tenantsFindFirstMock.mockResolvedValue({
    id: 'tenant-a',
    country: 'IN',
    discount_threshold_percent: new Prisma.Decimal('15.00'),
    business_name: 'Ambel Test Shop',
    gst_status: 'unregistered',
  })
  storesFindFirstMock.mockResolvedValue({
    id: storeId,
    is_active: true,
    tax_rate_state: new Prisma.Decimal('0'),
    tax_rate_county: new Prisma.Decimal('0'),
    tax_rate_city: new Prisma.Decimal('0'),
    tax_rate_district: new Prisma.Decimal('0'),
  })
  variantStockFindFirstMock.mockResolvedValue(null)
  customersFindFirstMock.mockResolvedValue(customerRow())
  customersFindManyMock.mockResolvedValue([customerRow()])
  staffFindFirstMock.mockResolvedValue({ id: staffId })
  staffFindManyMock.mockResolvedValue([{ id: staffId, name: 'Owner A' }])
  creditGroupByMock.mockResolvedValue([])
  queryRawMock.mockResolvedValue([{ id: customerId, credit_limit: null }])
  effectivePricesMock.mockResolvedValue([new Prisma.Decimal('100.00')])
  saleLinesCreateMock.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: '77777777-7777-4777-8777-777777777777',
    unit_price: new Prisma.Decimal(data.unit_price),
    discount_amount: new Prisma.Decimal(data.discount_amount),
    line_total: new Prisma.Decimal(data.line_total),
  }))
  paymentsCreateMock.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: randomUUID(),
    amount: new Prisma.Decimal(data.amount),
    created_at: new Date('2026-08-10T10:00:00.000Z'),
  }))
  creditCreateMock.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: '88888888-8888-4888-8888-888888888888',
    amount: new Prisma.Decimal(data.amount),
    created_at: new Date('2026-08-10T10:00:00.000Z'),
  }))
  stockCreateMock.mockResolvedValue({})
  salesCreateMock.mockImplementation(async ({ data }: any) => saleRow(data))
}

async function buildApp(role: 'owner' | 'manager' | 'cashier' = 'owner') {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res, next) => {
    req.user = { id: 'user-a', role, tenantId: 'tenant-a', storeId }
    req.storeContext = { scope: 'store', activeStoreId: storeId, actingRemotely: false }
    req.actingStaff = { id: staffId, role, storeId }
    next()
  })
  const { default: router } = await import('../../src/routes/sales')
  app.use('/sales', router)
  return app
}

const splitTenderBody = {
  clientSaleId: '99999999-9999-4999-8999-999999999999',
  shiftId,
  lines: [{ variantId, quantity: 1 }],
  payments: [
    { method: 'cash', amount: '60.00' },
    { method: 'credit', amount: '58.00' },
  ],
  customer: { id: customerId },
}

describe('POST /sales customer-credit checkout path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTransactionMocks()
  })

  it('records a split cash plus credit payment and one matching credit-sale ledger row atomically', async () => {
    const app = await buildApp('cashier')
    const response = await request(app).post('/sales').send(splitTenderBody)

    expect(response.status).toBe(201)
    expect(response.body.totalAmount).toBe('118.00')
    expect(paymentsCreateMock).toHaveBeenCalledTimes(2)
    expect(paymentsCreateMock.mock.calls.map(([call]) => call.data.method)).toEqual(['cash', 'credit'])
    expect(creditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: 'tenant-a',
        customer_id: customerId,
        store_id: storeId,
        type: 'credit_sale',
        amount: '58.00',
        sale_id: saleId,
        recorded_by: staffId,
      }),
    })
    expect(creditCreateMock).toHaveBeenCalledTimes(1)
  })

  it('warns a cashier at the credit limit and does not write the sale or ledger', async () => {
    const app = await buildApp('cashier')
    queryRawMock.mockResolvedValue([{ id: customerId, credit_limit: new Prisma.Decimal('100.00') }])
    creditGroupByMock.mockResolvedValue([
      { customer_id: customerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('70.00') }, _max: { created_at: new Date() } },
    ])

    const response = await request(app).post('/sales').send({
      ...splitTenderBody,
      clientSaleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      payments: [{ method: 'credit', amount: '118.00' }],
    })

    expect(response.status).toBe(403)
    expect(response.body.code).toBe('credit_limit_override_required')
    expect(response.body).toMatchObject({ balance: '70.00', creditLimit: '100.00', requestedCredit: '118.00' })
    expect(salesCreateMock).not.toHaveBeenCalled()
    expect(creditCreateMock).not.toHaveBeenCalled()
  })

  it('lets a manager override an exceeded credit limit while retaining the ledger amount', async () => {
    const app = await buildApp('manager')
    queryRawMock.mockResolvedValue([{ id: customerId, credit_limit: new Prisma.Decimal('100.00') }])
    creditGroupByMock.mockResolvedValue([
      { customer_id: customerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('70.00') }, _max: { created_at: new Date() } },
    ])

    const response = await request(app).post('/sales').send({
      ...splitTenderBody,
      clientSaleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      payments: [{ method: 'credit', amount: '118.00' }],
    })

    expect(response.status).toBe(201)
    expect(creditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'credit_sale', amount: '118.00', recorded_by: staffId }),
    })
  })
})
