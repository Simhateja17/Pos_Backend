import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()
const tenantsFindFirstMock = vi.fn()
const staffFindFirstMock = vi.fn()
const storesFindFirstMock = vi.fn()
const membershipFindFirstMock = vi.fn()
const customersFindManyMock = vi.fn()
const customersCountMock = vi.fn()
const salesFindManyMock = vi.fn()
const salesCountMock = vi.fn()
const taxDocumentsFindManyMock = vi.fn()
const linesFindManyMock = vi.fn()
const paymentsFindManyMock = vi.fn()
const paymentsCountMock = vi.fn()
const paymentsGroupByMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { findFirst: tenantsFindFirstMock },
    staff_members: {
      findFirst: (args: { where?: { role?: string } }) =>
        args.where?.role ? membershipFindFirstMock(args) : staffFindFirstMock(args),
    },
    customers: { findMany: customersFindManyMock, count: customersCountMock },
    sales: { findMany: salesFindManyMock, count: salesCountMock },
    tax_documents: { findMany: taxDocumentsFindManyMock },
    sale_line_items: { findMany: linesFindManyMock },
    payments: { findMany: paymentsFindManyMock, count: paymentsCountMock, groupBy: paymentsGroupByMock },
  })),
  forTenantTransaction: vi.fn(async (_tenantId: string, callback: (tx: any) => Promise<unknown>) =>
    callback({
      tenants: { findFirst: tenantsFindFirstMock },
      stores: { findFirst: storesFindFirstMock },
      staff_members: {
        findFirst: (args: { where?: { role?: string } }) =>
          args.where?.role ? membershipFindFirstMock(args) : staffFindFirstMock(args),
      },
      billing_subscriptions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      terminals: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      staff_sessions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
    }),
  ),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(tenantId = 'tenant-real') {
  return fakeJwt({ sub: 'user-123', role: 'owner', tenant_id: tenantId })
}

async function buildApp() {
  const { authMiddleware } = await import('../../src/middleware/auth')
  const { storeContextMiddleware } = await import('../../src/middleware/storeContext')
  const { default: contextRouter } = await import('../../src/routes/context')
  const { default: customersRouter } = await import('../../src/routes/customers')
  const { default: salesRouter } = await import('../../src/routes/sales')
  const app = express()
  app.use(express.json())
  app.use('/context', authMiddleware, storeContextMiddleware, contextRouter)
  app.use('/customers', authMiddleware, customersRouter)
  app.use('/sales', authMiddleware, storeContextMiddleware, salesRouter)
  return app
}

describe('context and tenant record read routes', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    tenantsFindFirstMock.mockReset()
    staffFindFirstMock.mockReset()
    membershipFindFirstMock.mockReset().mockResolvedValue({ role: 'owner', tenant_id: 'tenant-real', store_id: 'store-1', is_active: true })
    storesFindFirstMock.mockReset().mockResolvedValue({
      id: 'store-1', name: 'Bandra', city: 'Mumbai', state: 'Maharashtra',
      tax_rate_state: 0.025, tax_rate_county: 0.01, tax_rate_city: 0.005, tax_rate_district: 0,
    })
    customersFindManyMock.mockReset().mockResolvedValue([])
    customersCountMock.mockReset().mockResolvedValue(0)
    salesFindManyMock.mockReset().mockResolvedValue([])
    salesCountMock.mockReset().mockResolvedValue(0)
    taxDocumentsFindManyMock.mockReset().mockResolvedValue([])
    linesFindManyMock.mockReset().mockResolvedValue([])
    paymentsFindManyMock.mockReset().mockResolvedValue([])
    paymentsCountMock.mockReset().mockResolvedValue(0)
    paymentsGroupByMock.mockReset().mockResolvedValue([])
  })

  it('rejects unauthenticated context reads', async () => {
    const app = await buildApp()
    expect((await request(app).get('/context')).status).toBe(401)
  })

  it('returns only verified caller/tenant display context and ignores forged tenant query data', async () => {
    tenantsFindFirstMock.mockResolvedValue({
      id: 'tenant-real', business_name: 'Real Shop', city: 'Mumbai', state: 'Maharashtra', onboarding_step: 3, onboarding_completed_at: null,
    })
    staffFindFirstMock.mockResolvedValue({ id: 'staff-1', name: 'Real Owner' })
    const app = await buildApp()
    const response = await request(app).get('/context?tenantId=tenant-other').set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      staff: { id: 'staff-1', name: 'Real Owner', role: 'owner' },
      tenant: { id: 'tenant-real', businessName: 'Real Shop', locality: 'Mumbai, Maharashtra' },
      store: { id: 'store-1', name: 'Bandra', locality: 'Mumbai, Maharashtra', combinedTaxRatePercent: '4.0000', taxTreatment: 'cgst_sgst' },
      onboarding: { step: 3, completed: false },
    })
    const { forTenantTransaction } = await import('../../src/db/tenantClient')
    expect(forTenantTransaction).toHaveBeenCalledWith('tenant-real', expect.any(Function))
  })

  it('reports interstate tax treatment when the configured place of supply differs', async () => {
    tenantsFindFirstMock.mockResolvedValue({
      id: 'tenant-real', business_name: 'Real Shop', city: 'Mumbai', state: 'Maharashtra', onboarding_step: 3, onboarding_completed_at: null,
    })
    staffFindFirstMock.mockResolvedValue({ id: 'staff-1', name: 'Real Owner' })
    storesFindFirstMock.mockResolvedValue({
      id: 'store-1', name: 'Bandra', city: 'Mumbai', state: 'Maharashtra', place_of_supply: 'Karnataka',
      tax_rate_state: 0.09, tax_rate_county: 0.09, tax_rate_city: 0, tax_rate_district: 0,
    })

    const response = await request(await buildApp()).get('/context').set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body.store.taxTreatment).toBe('igst')
  })

  it('caps invalid pagination and returns an honest empty customer record page', async () => {
    const app = await buildApp()
    const invalid = await request(app).get('/customers/records?limit=101').set('Authorization', `Bearer ${tokenFor()}`)
    expect(invalid.status).toBe(400)

    const empty = await request(app).get('/customers/records?limit=25&tenantId=tenant-other').set('Authorization', `Bearer ${tokenFor()}`)
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ items: [], total: 0, nextCursor: null })
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('tenant-real')
  })

  it('uses JWT tenant scope for filtered sale records and never treats client tenant fields as filters', async () => {
    const app = await buildApp()
    const response = await request(app)
      .get('/sales/records?status=completed&limit=1&tenantId=tenant-other')
      .set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ items: [], total: 0, nextCursor: null })
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: { status: 'completed', store_id: 'store-1' },
    }))
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('tenant-real')
  })

  it('finds a sale by the invoice reference rendered in the orders table', async () => {
    const sale = {
      id: 'dcfb11a0-1111-4111-8111-111111111111',
      client_sale_id: '21111111-1111-4111-8111-111111111111',
      shift_id: null,
      customer_id: null,
      subtotal: { toString: () => '1532.82' },
      discount_amount: { toString: () => '0.00' },
      tax_amount: { toString: () => '0.00' },
      total_amount: { toString: () => '1532.82' },
      status: 'completed',
      created_by: null,
      created_at: new Date('2026-08-15T13:11:00.000Z'),
    }
    salesFindManyMock.mockResolvedValue([sale])
    salesCountMock.mockResolvedValue(1)
    linesFindManyMock.mockResolvedValue([])
    paymentsFindManyMock.mockResolvedValue([])

    const response = await request(await buildApp())
      .get('/sales/records')
      .query({ search: 'DCFB11A0', limit: 25 })
      .set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      items: [{ id: sale.id, invoiceNumber: null }],
      total: 1,
    })
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([{ id: { startsWith: 'dcfb11a0' } }]),
      }),
    }))
  })

  it('finds a sale by its persisted tax invoice number and returns that number', async () => {
    const sale = {
      id: 'eafb11a0-1111-4111-8111-111111111111',
      client_sale_id: '31111111-1111-4111-8111-111111111111',
      shift_id: null,
      customer_id: null,
      subtotal: { toString: () => '2500.00' },
      discount_amount: { toString: () => '0.00' },
      tax_amount: { toString: () => '0.00' },
      total_amount: { toString: () => '2500.00' },
      status: 'completed',
      created_by: null,
      created_at: new Date('2026-08-15T14:00:00.000Z'),
    }
    salesFindManyMock.mockResolvedValue([sale])
    salesCountMock.mockResolvedValue(1)
    taxDocumentsFindManyMock.mockResolvedValue([{ sale_id: sale.id, document_number: 'AMB/26-27/000001' }])
    linesFindManyMock.mockResolvedValue([])
    paymentsFindManyMock.mockResolvedValue([])

    const response = await request(await buildApp())
      .get('/sales/records')
      .query({ search: 'AMB/26-27/000001', limit: 25 })
      .set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      items: [{ id: sale.id, invoiceNumber: 'AMB/26-27/000001' }],
      total: 1,
    })
  })

  it('returns payment totals from persisted groupBy results, not client supplied totals', async () => {
    paymentsGroupByMock.mockResolvedValue([
      { direction: 'payment', _sum: { amount: '150.00' } },
      { direction: 'refund', _sum: { amount: '20.00' } },
    ])
    const app = await buildApp()
    const response = await request(app)
      .get('/sales/payments?method=cash&limit=10&total=999999&tenantId=tenant-other')
      .set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [], total: 0, nextCursor: null,
      summary: { collectedAmount: '150.00', refundedAmount: '20.00', netAmount: '130.00' },
    })
    expect(paymentsGroupByMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { method: 'cash', sales: { store_id: 'store-1' } },
    }))
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('tenant-real')
  })
})
