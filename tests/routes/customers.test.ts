import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'

const customersFindManyMock = vi.fn()
const customersCountMock = vi.fn()
const customersFindFirstMock = vi.fn()
const customersCreateMock = vi.fn()
const customersUpdateMock = vi.fn()
const salesFindManyMock = vi.fn()
const salesCountMock = vi.fn()
const storesFindManyMock = vi.fn()
const paymentsFindManyMock = vi.fn()
const shiftsFindFirstMock = vi.fn()

const client = {
  customers: {
    findMany: customersFindManyMock,
    count: customersCountMock,
    findFirst: customersFindFirstMock,
    create: customersCreateMock,
    update: customersUpdateMock,
  },
  sales: { findMany: salesFindManyMock, count: salesCountMock },
  stores: { findMany: storesFindManyMock },
  payments: { findMany: paymentsFindManyMock },
  shifts: { findFirst: shiftsFindFirstMock },
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => client),
  forTenantTransaction: vi.fn(async (_tenantId: string, callback: (tx: any) => Promise<any>) => callback(client)),
}))

vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(async () => ({ id: 'counter-1' })),
}))

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: 'tenant-a',
    name: 'Asha Rao',
    billing_name: 'Asha Rao',
    phone: '+919876543210',
    email: 'asha@example.com',
    gstin: '27ABCDE1234F1Z5',
    address_line1: '12 Hill Road',
    address_line2: null,
    city: 'Mumbai',
    state_code: '27',
    postal_code: '400001',
    country: 'IN',
    notes: null,
    created_at: new Date('2026-08-01T10:00:00.000Z'),
    updated_at: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  }
}

function buildApp(role: 'owner' | 'manager' | 'cashier' = 'owner', scope: 'store' | 'business' = 'store') {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res, next) => {
    req.user = { id: 'user-a', role, tenantId: 'tenant-a', storeId: 'store-a' }
    req.storeContext = {
      scope,
      activeStoreId: scope === 'store' ? 'store-a' : null,
      actingRemotely: false,
    }
    next()
  })
  return import('../../src/routes/customers').then(({ default: router }) => {
    app.use('/customers', router)
    return app
  })
}

describe('customer profile routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    customersFindManyMock.mockResolvedValue([])
    customersCountMock.mockResolvedValue(0)
    customersFindFirstMock.mockResolvedValue(null)
    customersCreateMock.mockImplementation(async ({ data }: any) => customerRow(data))
    customersUpdateMock.mockImplementation(async ({ data }: any) => customerRow(data))
    salesFindManyMock.mockResolvedValue([])
    salesCountMock.mockResolvedValue(0)
    storesFindManyMock.mockResolvedValue([])
    paymentsFindManyMock.mockResolvedValue([])
    shiftsFindFirstMock.mockResolvedValue(null)
  })

  it('creates a GST customer with canonical identity and billing fields', async () => {
    const app = await buildApp('cashier')
    const response = await request(app).post('/customers').send({
      billingName: 'Asha Rao',
      phone: '09876543210',
      email: ' ASHA@EXAMPLE.COM ',
      gstin: '27abcde1234f1z5',
      addressLine1: '12 Hill Road',
      city: 'Mumbai',
      stateCode: '27',
      postalCode: '400001',
    })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      billingName: 'Asha Rao',
      phone: '+919876543210',
      email: 'asha@example.com',
      gstin: '27ABCDE1234F1Z5',
      stateCode: '27',
      postalCode: '400001',
    })
    expect(customersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenant_id: 'tenant-a',
        phone: '+919876543210',
        email: 'asha@example.com',
        billing_name: 'Asha Rao',
      }),
    }))
  })

  it('returns 409 for an existing identity and never guesses a collision', async () => {
    const app = await buildApp()
    customersFindManyMock.mockResolvedValue([customerRow()])
    const duplicate = await request(app).post('/customers').send({ phone: '9876543210' })
    expect(duplicate.status).toBe(409)

    customersFindManyMock.mockResolvedValue([
      customerRow({ id: '11111111-1111-4111-8111-111111111111', email: null }),
      customerRow({ id: '22222222-2222-4222-8222-222222222222', phone: null }),
    ])
    const collision = await request(app).post('/customers').send({ phone: '9876543210', email: 'asha@example.com' })
    expect(collision.status).toBe(409)
    expect(collision.body.error).toMatch(/different existing customers/i)
  })

  it('edits allowed profile fields and rejects clearing the last identity', async () => {
    const app = await buildApp('manager')
    customersFindFirstMock.mockResolvedValue(customerRow())
    customersFindManyMock.mockResolvedValue([customerRow()])
    customersUpdateMock.mockResolvedValue(customerRow({ city: 'Pune', updated_at: new Date('2026-08-02T10:00:00.000Z') }))

    const updated = await request(app)
      .patch('/customers/11111111-1111-4111-8111-111111111111')
      .send({ city: 'Pune' })
    expect(updated.status).toBe(200)
    expect(updated.body.city).toBe('Pune')
    expect(customersUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '11111111-1111-4111-8111-111111111111' },
    }))

    const invalid = await request(app)
      .patch('/customers/11111111-1111-4111-8111-111111111111')
      .send({ phone: null, email: null })
    expect(invalid.status).toBe(400)
  })

  it('returns persisted, store-scoped purchase summaries without N+1 detail calls', async () => {
    const app = await buildApp('manager')
    customersFindFirstMock.mockResolvedValue(customerRow())
    const saleId = '33333333-3333-4333-8333-333333333333'
    salesFindManyMock.mockResolvedValue([{
      id: saleId,
      store_id: 'store-a',
      total_amount: { toString: () => '1250.00' },
      status: 'completed',
      created_at: new Date('2026-08-03T10:00:00.000Z'),
    }])
    salesCountMock.mockResolvedValue(1)
    storesFindManyMock.mockResolvedValue([{ id: 'store-a', name: 'Bandra' }])
    paymentsFindManyMock.mockResolvedValue([{ sale_id: saleId, method: 'cash' }, { sale_id: saleId, method: 'cash' }])

    const response = await request(app).get('/customers/11111111-1111-4111-8111-111111111111/purchases')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [{
        id: saleId,
        documentId: null,
        documentNumber: null,
        documentType: null,
        date: '2026-08-03T10:00:00.000Z',
        store: { id: 'store-a', name: 'Bandra' },
        total: '1250.00',
        status: 'completed',
        paymentMethods: ['cash'],
      }],
      total: 1,
      nextCursor: null,
    })
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { customer_id: '11111111-1111-4111-8111-111111111111', store_id: 'store-a' },
    }))
    expect(paymentsFindManyMock).toHaveBeenCalledTimes(1)
  })

  it('lets an owner use business scope while keeping the customer identity tenant-scoped', async () => {
    const app = await buildApp('owner', 'business')
    customersFindFirstMock.mockResolvedValue(customerRow())
    const saleId = '33333333-3333-4333-8333-333333333333'
    salesFindManyMock.mockResolvedValue([{
      id: saleId,
      store_id: 'store-b',
      total_amount: { toString: () => '900.00' },
      status: 'completed',
      created_at: new Date('2026-08-03T10:00:00.000Z'),
    }])
    salesCountMock.mockResolvedValue(1)
    storesFindManyMock.mockResolvedValue([{ id: 'store-b', name: 'Andheri' }])

    const response = await request(app).get('/customers/11111111-1111-4111-8111-111111111111/purchases')

    expect(response.status).toBe(200)
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { customer_id: '11111111-1111-4111-8111-111111111111' },
    }))
  })

  it('limits cashier history to the paired counter current shift', async () => {
    const app = await buildApp('cashier')
    customersFindFirstMock.mockResolvedValue(customerRow())
    shiftsFindFirstMock.mockResolvedValue({ id: 'shift-1' })
    salesFindManyMock.mockResolvedValue([])
    salesCountMock.mockResolvedValue(0)

    const response = await request(app).get('/customers/11111111-1111-4111-8111-111111111111/purchases')

    expect(response.status).toBe(200)
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { customer_id: '11111111-1111-4111-8111-111111111111', store_id: 'store-a', shift_id: 'shift-1' },
    }))
  })

  it('returns 404 for a customer outside the tenant-scoped client', async () => {
    const app = await buildApp()
    customersFindFirstMock.mockResolvedValue(null)
    const response = await request(app).get('/customers/11111111-1111-4111-8111-111111111111')
    expect(response.status).toBe(404)
  })
})
