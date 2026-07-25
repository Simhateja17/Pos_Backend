import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()
const salesFindManyMock = vi.fn()
const shiftsFindFirstMock = vi.fn()
const variantsFindManyMock = vi.fn()
const stockLevelsFindManyMock = vi.fn()
const productsFindManyMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    sales: { findMany: salesFindManyMock },
    shifts: { findFirst: shiftsFindFirstMock },
    variants: { findMany: variantsFindManyMock },
    variant_stock_levels: { findMany: stockLevelsFindManyMock },
    products: { findMany: productsFindManyMock },
  })),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(tenantId = '11111111-1111-4111-8111-111111111111') {
  return fakeJwt({ sub: 'user-123', role: 'owner', tenant_id: tenantId })
}

async function buildApp() {
  const { authMiddleware } = await import('../../src/middleware/auth')
  const { default: dashboardRouter } = await import('../../src/routes/dashboard')
  const app = express()
  app.use('/dashboard', authMiddleware, dashboardRouter)
  return app
}

describe('dashboard route', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    salesFindManyMock.mockReset().mockResolvedValue([])
    shiftsFindFirstMock.mockReset().mockResolvedValue(null)
    variantsFindManyMock.mockReset().mockResolvedValue([])
    stockLevelsFindManyMock.mockReset().mockResolvedValue([])
    productsFindManyMock.mockReset().mockResolvedValue([])
  })

  it('rejects unauthenticated dashboard reads', async () => {
    const app = await buildApp()
    expect((await request(app).get('/dashboard')).status).toBe(401)
  })

  it('rejects ranges outside the approved bounded set', async () => {
    const app = await buildApp()
    const response = await request(app).get('/dashboard?range=90d').set('Authorization', `Bearer ${tokenFor()}`)
    expect(response.status).toBe(400)
    expect((await request(app).get('/dashboard?tenantId=99999999-9999-4999-8999-999999999999').set('Authorization', `Bearer ${tokenFor()}`)).status).toBe(400)
  })

  it('returns truthful empty states with unsupported metrics explicitly unavailable', async () => {
    const app = await buildApp()
    const response = await request(app).get('/dashboard?range=7d').set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body.sales).toEqual({
      totalAmount: '0.00', billCount: 0, averageBillAmount: '0.00',
      grossMargin: { status: 'unavailable', reason: 'Canonical product cost data is not persisted.' },
    })
    expect(response.body).toMatchObject({
      range: '7d', cashDrawer: { status: 'no_open_shift' }, lowStock: { count: 0, items: [] },
      settlement: { status: 'unavailable', reason: 'Settlement status is not persisted.' },
      trend: { revenue: [], profit: { status: 'unavailable' } }, actionable: { items: [] },
    })
  })

  it('derives populated totals, revenue points, stock alerts, and drawer state from scoped records only', async () => {
    const firstSaleAt = new Date('2026-07-23T06:30:00.000Z')
    const secondSaleAt = new Date('2026-07-23T10:30:00.000Z')
    salesFindManyMock.mockResolvedValue([
      { total_amount: '100.00', created_at: firstSaleAt },
      { total_amount: '50.00', created_at: secondSaleAt },
    ])
    shiftsFindFirstMock.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222', starting_cash: '500.00', opened_at: firstSaleAt,
    })
    variantsFindManyMock.mockResolvedValue([{
      id: '33333333-3333-4333-8333-333333333333', product_id: '44444444-4444-4444-8444-444444444444', sku: 'KURTA-1', reorder_threshold: 4,
    }])
    stockLevelsFindManyMock.mockResolvedValue([{ variant_id: '33333333-3333-4333-8333-333333333333', quantity: 2 }])
    productsFindManyMock.mockResolvedValue([{ id: '44444444-4444-4444-8444-444444444444', name: 'Indigo Kurta' }])
    const app = await buildApp()
    const response = await request(app)
      .get('/dashboard?range=14d')
      .set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body.sales).toMatchObject({ totalAmount: '150.00', billCount: 2, averageBillAmount: '75.00' })
    expect(response.body.trend.revenue).toEqual([{ date: '2026-07-23', amount: '150.00' }])
    expect(response.body.lowStock).toEqual({ count: 1, items: [{
      variantId: '33333333-3333-4333-8333-333333333333', productId: '44444444-4444-4444-8444-444444444444',
      productName: 'Indigo Kurta', sku: 'KURTA-1', quantity: 2, reorderThreshold: 4,
    }] })
    expect(response.body.cashDrawer).toMatchObject({ status: 'open', openingCash: '500.00' })
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111')
    expect(salesFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'completed' }) }))
  })

  it('does not expose cross-tenant records from a separate tenant-scoped fixture', async () => {
    // The mocked tenant client represents the caller's RLS-scoped view: the
    // foreign 999... tenant fixture is deliberately absent from this result.
    salesFindManyMock.mockResolvedValue([{ total_amount: '25.00', created_at: new Date('2026-07-24T06:30:00.000Z') }])
    const app = await buildApp()
    const response = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.status).toBe(200)
    expect(response.body.sales.totalAmount).toBe('25.00')
    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111')
  })
})
