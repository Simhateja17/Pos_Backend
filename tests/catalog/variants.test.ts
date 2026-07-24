import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string) => ({ auth: { getUser: getUserMock } })),
}))

const productsCreateMock = vi.fn()
const productsFindManyMock = vi.fn()
const productsFindFirstMock = vi.fn()
const variantsCreateMock = vi.fn()
const variantsFindManyMock = vi.fn()
const variantsFindFirstMock = vi.fn()
const variantStockLevelsFindManyMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    products: {
      create: productsCreateMock,
      findMany: productsFindManyMock,
      findFirst: productsFindFirstMock,
    },
    variants: {
      create: variantsCreateMock,
      findMany: variantsFindManyMock,
      findFirst: variantsFindFirstMock,
    },
    variant_stock_levels: {
      findMany: variantStockLevelsFindManyMock,
    },
  })),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier', tenantId = 'tenant-abc') {
  return fakeJwt({ sub: 'user-123', role, tenant_id: tenantId })
}

describe('products routes — variants (CATALOG-01)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    productsCreateMock.mockReset()
    productsFindManyMock.mockReset()
    productsFindFirstMock.mockReset()
    variantsCreateMock.mockReset()
    variantsFindManyMock.mockReset()
    variantsFindFirstMock.mockReset()
    variantStockLevelsFindManyMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    variantsFindFirstMock.mockResolvedValue(null) // no SKU collisions by default
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: productsRouter } = await import('../../src/routes/products')
    const app = express()
    app.use(express.json())
    app.use('/products', authMiddleware, productsRouter)
    return app
  }

  it('Test 1: POST /products with a size/color variant returns 201 with an auto-generated SKU', async () => {
    productsCreateMock.mockResolvedValue({
      id: 'product-1',
      name: 'Blue Dress',
      category: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })
    variantsCreateMock.mockResolvedValue({
      id: 'variant-1',
      product_id: 'product-1',
      sku: 'BLUE-0001',
      size: 'M',
      color: 'Blue',
      material: null,
      price: '49.99',
      reorder_threshold: 4,
      identity_locked: false,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ name: 'Blue Dress', variants: [{ size: 'M', color: 'Blue', price: 49.99 }] })

    expect(res.status).toBe(201)
    expect(res.body.variants).toHaveLength(1)
    expect(res.body.variants[0].sku).toMatch(/^[A-Z0-9]{1,4}-\d{4}$/)
  })

  it('Test 2: POST /products with a one-size product (no size/color/material) returns exactly 1 default variant', async () => {
    productsCreateMock.mockResolvedValue({
      id: 'product-2',
      name: 'One Size Scarf',
      category: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })
    variantsCreateMock.mockResolvedValue({
      id: 'variant-2',
      product_id: 'product-2',
      sku: 'ONES-0001',
      size: null,
      color: null,
      material: null,
      price: '19.99',
      reorder_threshold: 4,
      identity_locked: false,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)
      .send({ name: 'One Size Scarf', variants: [{ price: 19.99 }] })

    expect(res.status).toBe(201)
    expect(res.body.variants).toHaveLength(1)
    expect(res.body.variants[0].size).toBeNull()
  })

  it('Test 3: POST /products with variants: [] returns 400', async () => {
    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)
      .send({ name: 'X', variants: [] })

    expect(res.status).toBe(400)
    expect(productsCreateMock).not.toHaveBeenCalled()
  })
})
