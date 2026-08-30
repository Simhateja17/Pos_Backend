import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'

const customerFindManyMock = vi.fn()
const customerFindFirstMock = vi.fn()
const customerCountMock = vi.fn()
const customerUpdateMock = vi.fn()
const creditGroupByMock = vi.fn()
const creditFindManyMock = vi.fn()
const creditCreateMock = vi.fn()
const storesFindManyMock = vi.fn()
const staffFindFirstMock = vi.fn()
const queryRawMock = vi.fn()

const client = {
  customers: {
    findMany: customerFindManyMock,
    findFirst: customerFindFirstMock,
    count: customerCountMock,
    update: customerUpdateMock,
  },
  customer_credit_transactions: {
    groupBy: creditGroupByMock,
    findMany: creditFindManyMock,
    create: creditCreateMock,
  },
  stores: { findMany: storesFindManyMock },
  staff_members: { findFirst: staffFindFirstMock },
  $queryRaw: queryRawMock,
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => client),
  forTenantTransaction: vi.fn(async (_tenantId: string, callback: (tx: any) => Promise<unknown>) => callback(client)),
}))

vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(async () => ({ id: 'counter-1' })),
}))

const customerId = '11111111-1111-4111-8111-111111111111'
const secondCustomerId = '22222222-2222-4222-8222-222222222222'
const storeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const storeB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const saleId = '33333333-3333-4333-8333-333333333333'
const staffId = '44444444-4444-4444-8444-444444444444'

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: customerId,
    tenant_id: 'tenant-a',
    name: 'Asha Rao',
    billing_name: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@example.com',
    credit_limit: null,
    created_at: new Date('2026-08-01T10:00:00.000Z'),
    updated_at: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  }
}

function transactionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenant_id: 'tenant-a',
    customer_id: customerId,
    store_id: storeA,
    type: 'credit_sale',
    amount: new Prisma.Decimal('100.00'),
    sale_id: saleId,
    recorded_by: staffId,
    note: null,
    created_at: new Date('2026-08-03T10:00:00.000Z'),
    ...overrides,
  }
}

async function buildCustomerApp(role: 'owner' | 'manager' | 'cashier' = 'owner', scope: 'store' | 'business' = 'store') {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res, next) => {
    req.user = { id: 'user-a', role, tenantId: 'tenant-a', storeId: storeA }
    req.storeContext = {
      scope,
      activeStoreId: scope === 'store' ? storeA : null,
      actingRemotely: false,
    }
    req.actingStaff = { id: staffId, role, storeId: storeA }
    next()
  })
  const { default: router } = await import('../../src/routes/customers')
  app.use('/customers', router)
  return app
}

async function buildReceivablesApp() {
  const app = express()
  app.use((req: Request, _res, next) => {
    req.user = { id: 'user-a', role: 'cashier', tenantId: 'tenant-a', storeId: storeA }
    req.storeContext = { scope: 'store', activeStoreId: storeA, actingRemotely: false }
    req.actingStaff = { id: staffId, role: 'cashier', storeId: storeA }
    next()
  })
  const { default: router } = await import('../../src/routes/receivables')
  app.use('/receivables', router)
  return app
}

describe('customer credit routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    customerFindManyMock.mockResolvedValue([])
    customerFindFirstMock.mockResolvedValue(null)
    customerCountMock.mockResolvedValue(0)
    customerUpdateMock.mockImplementation(async ({ data }: any) => customerRow(data))
    creditGroupByMock.mockResolvedValue([])
    creditFindManyMock.mockResolvedValue([])
    creditCreateMock.mockImplementation(async ({ data }: any) => transactionRow({
      ...data,
      id: '66666666-6666-4666-8666-666666666666',
      amount: new Prisma.Decimal(data.amount),
      created_at: new Date('2026-08-04T10:00:00.000Z'),
    }))
    storesFindManyMock.mockResolvedValue([{ id: storeA, name: 'Main shop' }, { id: storeB, name: 'Second shop' }])
    staffFindFirstMock.mockResolvedValue({ id: staffId })
    queryRawMock.mockResolvedValue([{ id: customerId, credit_limit: null }])
  })

  it('derives a tenant-wide balance and preserves each ledger row store tag', async () => {
    const app = await buildCustomerApp()
    customerFindFirstMock.mockResolvedValue(customerRow({ credit_limit: new Prisma.Decimal('500.00') }))
    creditGroupByMock.mockResolvedValue([
      { customer_id: customerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('125.00') }, _max: { created_at: new Date('2026-08-03T10:00:00.000Z') } },
      { customer_id: customerId, type: 'repayment', _sum: { amount: new Prisma.Decimal('25.00') }, _max: { created_at: new Date('2026-08-04T10:00:00.000Z') } },
    ])
    creditFindManyMock.mockResolvedValue([
      transactionRow({ store_id: storeA, amount: new Prisma.Decimal('125.00') }),
      transactionRow({ store_id: storeB, type: 'repayment', amount: new Prisma.Decimal('25.00'), sale_id: null }),
    ])

    const response = await request(app).get(`/customers/${customerId}/credit`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ customerId, balance: '100.00', creditLimit: '500.00' })
    expect(response.body.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'credit_sale', amount: '125.00', storeId: storeA, storeName: 'Main shop' }),
      expect.objectContaining({ type: 'repayment', amount: '25.00', storeId: storeB, storeName: 'Second shop', saleId: null }),
    ]))
    expect(creditGroupByMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { customer_id: { in: [customerId] }, tenant_id: 'tenant-a' },
    }))
  })

  it('appends a repayment at the active store and returns the reduced derived balance', async () => {
    const app = await buildCustomerApp('cashier')
    queryRawMock.mockResolvedValue([{ id: customerId, credit_limit: new Prisma.Decimal('500.00') }])
    creditGroupByMock.mockResolvedValue([
      { customer_id: customerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('100.00') }, _max: { created_at: new Date() } },
    ])

    const response = await request(app)
      .post(`/customers/${customerId}/credit/repayments`)
      .send({ amount: '40.00', note: 'Cash at counter' })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ balance: '60.00', creditLimit: '500.00' })
    expect(creditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: 'tenant-a',
        customer_id: customerId,
        store_id: storeA,
        type: 'repayment',
        amount: '40.00',
        sale_id: null,
        recorded_by: staffId,
        note: 'Cash at counter',
      }),
    })
  })

  it('rejects repayment above the current balance without appending a row', async () => {
    const app = await buildCustomerApp('cashier')
    creditGroupByMock.mockResolvedValue([
      { customer_id: customerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('25.00') }, _max: { created_at: new Date() } },
    ])

    const response = await request(app)
      .post(`/customers/${customerId}/credit/repayments`)
      .send({ amount: '25.01' })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('repayment_exceeds_balance')
    expect(creditCreateMock).not.toHaveBeenCalled()
  })

  it('allows managers to set a limit but rejects cashier limit changes', async () => {
    customerFindFirstMock.mockResolvedValue(customerRow())
    customerFindManyMock.mockResolvedValue([customerRow()])
    customerUpdateMock.mockResolvedValue(customerRow({ credit_limit: new Prisma.Decimal('1000.00') }))

    const managerResponse = await request(await buildCustomerApp('manager'))
      .patch(`/customers/${customerId}`)
      .send({ creditLimit: '1000.00' })
    expect(managerResponse.status).toBe(200)
    expect(managerResponse.body.creditLimit).toBe('1000.00')
    expect(customerUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ credit_limit: '1000.00' }) }))

    const cashierResponse = await request(await buildCustomerApp('cashier'))
      .patch(`/customers/${customerId}`)
      .send({ credit_limit: '900.00' })
    expect(cashierResponse.status).toBe(403)
    expect(customerUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('lists only positive balances across the tenant, regardless of active store', async () => {
    const app = await buildReceivablesApp()
    customerFindManyMock.mockResolvedValue([
      customerRow({ id: customerId, billing_name: 'Asha Rao', credit_limit: null }),
      customerRow({ id: secondCustomerId, name: 'Paid customer', billing_name: 'Paid customer' }),
    ])
    creditGroupByMock.mockResolvedValue([
      { customer_id: customerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('80.00') }, _max: { created_at: new Date('2026-08-05T10:00:00.000Z') } },
      { customer_id: customerId, type: 'repayment', _sum: { amount: new Prisma.Decimal('20.00') }, _max: { created_at: new Date('2026-08-06T10:00:00.000Z') } },
      { customer_id: secondCustomerId, type: 'credit_sale', _sum: { amount: new Prisma.Decimal('20.00') }, _max: { created_at: new Date('2026-08-05T10:00:00.000Z') } },
      { customer_id: secondCustomerId, type: 'repayment', _sum: { amount: new Prisma.Decimal('20.00') }, _max: { created_at: new Date('2026-08-06T10:00:00.000Z') } },
    ])

    const response = await request(app).get('/receivables').query({ sort: 'balance_desc' })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ total: 1, outstandingTotal: '60.00' })
    expect(response.body.items).toEqual([expect.objectContaining({ customerId, balance: '60.00' })])
    expect(customerFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: {} }))
    expect(creditGroupByMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { customer_id: { in: [customerId, secondCustomerId] }, tenant_id: 'tenant-a' },
    }))
  })
})

