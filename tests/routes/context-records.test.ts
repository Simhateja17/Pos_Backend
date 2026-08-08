import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()
const tenantsFindFirstMock = vi.fn()
const staffFindFirstMock = vi.fn()
const membershipFindFirstMock = vi.fn()
const customersFindManyMock = vi.fn()
const customersCountMock = vi.fn()
const salesFindManyMock = vi.fn()
const salesCountMock = vi.fn()
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
    sale_line_items: { findMany: linesFindManyMock },
    payments: { findMany: paymentsFindManyMock, count: paymentsCountMock, groupBy: paymentsGroupByMock },
  })),
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
  const { default: contextRouter } = await import('../../src/routes/context')
  const { default: customersRouter } = await import('../../src/routes/customers')
  const { default: salesRouter } = await import('../../src/routes/sales')
  const app = express()
  app.use(express.json())
  app.use('/context', authMiddleware, contextRouter)
  app.use('/customers', authMiddleware, customersRouter)
  app.use('/sales', authMiddleware, salesRouter)
  return app
}

describe('context and tenant record read routes', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    tenantsFindFirstMock.mockReset()
    staffFindFirstMock.mockReset()
    membershipFindFirstMock.mockReset().mockResolvedValue({ role: 'owner', tenant_id: 'tenant-real' })
    customersFindManyMock.mockReset().mockResolvedValue([])
    customersCountMock.mockReset().mockResolvedValue(0)
    salesFindManyMock.mockReset().mockResolvedValue([])
    salesCountMock.mockReset().mockResolvedValue(0)
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
      onboarding: { step: 3, completed: false },
    })
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenCalledWith('tenant-real')
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
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: { status: 'completed' } }))
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('tenant-real')
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
    expect(paymentsGroupByMock).toHaveBeenCalledWith(expect.objectContaining({ where: { method: 'cash' } }))
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('tenant-real')
  })
})
