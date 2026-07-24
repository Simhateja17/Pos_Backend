import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string) => ({ auth: { getUser: getUserMock } })),
}))

const variantsFindManyMock = vi.fn()
const variantStockLevelsFindManyMock = vi.fn()
const productsFindManyMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    variants: { findMany: variantsFindManyMock },
    variant_stock_levels: { findMany: variantStockLevelsFindManyMock },
    products: { findMany: productsFindManyMock },
  })),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier', tenantId = 'tenant-abc') {
  return fakeJwt({ sub: 'user-123', role, tenant_id: tenantId })
}

describe('GET /stock-movements/low-stock (INV-03)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    variantsFindManyMock.mockReset()
    variantStockLevelsFindManyMock.mockReset()
    productsFindManyMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    productsFindManyMock.mockResolvedValue([{ id: 'product-1', name: 'Blue Dress' }])
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: stockMovementsRouter } = await import('../../src/routes/stockMovements')
    const app = express()
    app.use(express.json())
    app.use('/stock-movements', authMiddleware, stockMovementsRouter)
    return app
  }

  it('Test 1: returns only variants where quantity <= reorder_threshold, filtering out healthy variants', async () => {
    variantsFindManyMock.mockResolvedValue([
      { id: 'v1', product_id: 'product-1', sku: 'BLUE-0001', size: 'S', color: 'Blue', material: null, reorder_threshold: 5 },
      { id: 'v2', product_id: 'product-1', sku: 'BLUE-0002', size: 'M', color: 'Blue', material: null, reorder_threshold: 5 },
    ])
    variantStockLevelsFindManyMock.mockResolvedValue([
      { variant_id: 'v1', quantity: 2 },
      { variant_id: 'v2', quantity: 20 },
    ])

    const app = await buildApp()
    const res = await request(app)
      .get('/stock-movements/low-stock')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0]).toEqual({
      variantId: 'v1',
      productId: 'product-1',
      productName: 'Blue Dress',
      sku: 'BLUE-0001',
      size: 'S',
      color: 'Blue',
      material: null,
      quantity: 2,
      reorderThreshold: 5,
    })
  })

  it('Test 2: a variant with no variant_stock_levels row is treated as quantity 0 and included when 0 <= reorder_threshold', async () => {
    variantsFindManyMock.mockResolvedValue([
      { id: 'v3', product_id: 'product-1', sku: 'BLUE-0003', size: 'L', color: 'Blue', material: null, reorder_threshold: 4 },
    ])
    variantStockLevelsFindManyMock.mockResolvedValue([]) // never had a movement

    const app = await buildApp()
    const res = await request(app)
      .get('/stock-movements/low-stock')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].quantity).toBe(0)
    expect(res.body[0].variantId).toBe('v3')
  })
})
