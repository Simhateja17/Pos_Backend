import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()
const salesFindManyMock = vi.fn()
const saleLineItemsFindManyMock = vi.fn()
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
    sale_line_items: { findMany: saleLineItemsFindManyMock },
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
    saleLineItemsFindManyMock.mockReset().mockResolvedValue([])
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
      grossMargin: { status: 'unavailable', reason: 'No sales in this period.' },
    })
    expect(response.body).toMatchObject({
      range: '7d', cashDrawer: { status: 'no_open_shift' }, lowStock: { count: 0, items: [] },
      settlement: {
        status: 'unavailable',
        reason: 'Payments are collected on your own card machine or UPI app, so we cannot see when they settle.',
      },
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

  // --- Phase 5: gross margin, now that goods receipt persists a cost basis.

  it('reports gross margin from the moving-average cost once items have a recorded cost', async () => {
    salesFindManyMock.mockResolvedValue([{ total_amount: '1000.00', created_at: new Date('2026-07-23T06:30:00.000Z') }])
    variantsFindManyMock.mockResolvedValue([
      { id: 'v-1', product_id: 'p-1', sku: 'K-1', reorder_threshold: 4, moving_average_cost: '400.00' },
    ])
    saleLineItemsFindManyMock.mockResolvedValue([{ variant_id: 'v-1', quantity: 2, line_total: '1000.00' }])

    const app = await buildApp()
    const response = await request(app).get('/dashboard').set('Authorization', `Bearer ${tokenFor()}`)

    // COGS = 2 * 400 = 800; margin = 1000 - 800 = 200, i.e. 20.0%.
    expect(response.status).toBe(200)
    expect(response.body.sales.grossMargin).toEqual({
      status: 'available',
      amount: '200.00',
      percent: '20.0',
      costOfGoodsSold: '800.00',
      costedRevenue: '1000.00',
      uncostedRevenue: '0.00',
    })
  })

  it('excludes items with no recorded cost rather than treating them as free', async () => {
    salesFindManyMock.mockResolvedValue([{ total_amount: '1500.00', created_at: new Date('2026-07-23T06:30:00.000Z') }])
    variantsFindManyMock.mockResolvedValue([
      { id: 'v-1', product_id: 'p-1', sku: 'K-1', reorder_threshold: 4, moving_average_cost: '400.00' },
      // Never received against a PO, so no cost basis exists for it.
      { id: 'v-2', product_id: 'p-1', sku: 'K-2', reorder_threshold: 4, moving_average_cost: null },
    ])
    saleLineItemsFindManyMock.mockResolvedValue([
      { variant_id: 'v-1', quantity: 2, line_total: '1000.00' },
      { variant_id: 'v-2', quantity: 1, line_total: '500.00' },
    ])

    const app = await buildApp()
    const response = await request(app).get('/dashboard').set('Authorization', `Bearer ${tokenFor()}`)

    // Treating v-2 as zero-cost would report 500 of pure profit and inflate
    // margin to 46.7%. Excluding it keeps the figure honest at 20.0% and
    // declares the 500 it could not account for.
    expect(response.body.sales.grossMargin).toEqual({
      status: 'available',
      amount: '200.00',
      percent: '20.0',
      costOfGoodsSold: '800.00',
      costedRevenue: '1000.00',
      uncostedRevenue: '500.00',
    })
  })

  it('stays unavailable, not zero, when sales exist but nothing sold has a cost yet', async () => {
    salesFindManyMock.mockResolvedValue([{ total_amount: '500.00', created_at: new Date('2026-07-23T06:30:00.000Z') }])
    variantsFindManyMock.mockResolvedValue([
      { id: 'v-2', product_id: 'p-1', sku: 'K-2', reorder_threshold: 4, moving_average_cost: null },
    ])
    saleLineItemsFindManyMock.mockResolvedValue([{ variant_id: 'v-2', quantity: 1, line_total: '500.00' }])

    const app = await buildApp()
    const response = await request(app).get('/dashboard').set('Authorization', `Bearer ${tokenFor()}`)

    expect(response.body.sales.grossMargin.status).toBe('unavailable')
    expect(response.body.sales.grossMargin.reason).toMatch(/recorded cost/)
  })
})
