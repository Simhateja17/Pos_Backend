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
// 0032: products now reference a real categories table, so the route resolves
// category names on every read and the create path may create one inline.
const categoriesFindManyMock = vi.fn(async () => [])
const categoriesFindFirstMock = vi.fn(async () => null)
const categoriesCreateMock = vi.fn(async () => ({ id: 'category-1' }))
const membershipFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    staff_members: { findFirst: membershipFindFirstMock },
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
    categories: {
      findMany: categoriesFindManyMock,
      findFirst: categoriesFindFirstMock,
      create: categoriesCreateMock,
    },
  })),
  // CR-02: POST /products now writes through forTenantTransaction, not
  // forTenant() — the mock callback receives the same tx-shaped client.
  forTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) =>
    fn({
      staff_members: { findFirst: membershipFindFirstMock },
      billing_subscriptions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      terminals: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      staff_sessions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      products: { create: productsCreateMock },
      variants: { create: variantsCreateMock, findFirst: variantsFindFirstMock },
      categories: {
        findFirst: categoriesFindFirstMock,
        create: categoriesCreateMock,
      },
    }),
  ),
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
    membershipFindFirstMock.mockReset().mockImplementation(({ where }: { where: { role?: string } }) => ({
      role: where.role,
      tenant_id: 'tenant-abc',
    }))
    variantsFindFirstMock.mockResolvedValue(null) // no SKU collisions by default
    variantStockLevelsFindManyMock.mockResolvedValue([])
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: productsRouter } = await import('../../src/routes/products')
    const app = express()
    app.use(express.json())
    // The production router is mounted after storeContextMiddleware. This
    // fixture exercises the business-wide read shape used by an owner.
    app.use((req, _res, next) => {
      req.storeContext = { scope: 'business', activeStoreId: null, actingRemotely: false }
      next()
    })
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
      tax_rate: '0.12',
      reorder_threshold: 4,
      identity_locked: false,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ name: 'Blue Dress', variants: [{ size: 'M', color: 'Blue', price: 49.99, taxRatePercent: 12 }] })

    expect(res.status).toBe(201)
    expect(res.body.variants).toHaveLength(1)
    expect(res.body.variants[0].sku).toMatch(/^[A-Z0-9]{1,4}-\d{4}$/)
    expect(variantsCreateMock.mock.calls[0][0].data.tax_rate.toString()).toBe('0.12')
    expect(res.body.variants[0].taxRatePercent).toBe('12')
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
      .set('Authorization', `Bearer ${tokenFor('manager')}`)
      .send({ name: 'One Size Scarf', variants: [{ price: 19.99, taxRatePercent: 5 }] })

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

  it('GET /products includes the moving-average cost used for inventory valuation', async () => {
    productsFindManyMock.mockResolvedValue([
      {
        id: 'product-3',
        name: 'Costed Kurta',
        category_id: null,
        category: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        variants: [
          {
            id: 'variant-3',
            product_id: 'product-3',
            sku: 'COST-0001',
            barcode: null,
            unit_of_measure: 'piece',
            size: 'M',
            color: 'Blue',
            material: null,
            price: '1000.00',
            moving_average_cost: '400.00',
            is_taxable: true,
            reorder_threshold: '3',
            identity_locked: false,
            created_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      },
    ])
    variantStockLevelsFindManyMock.mockResolvedValue([{ variant_id: 'variant-3', quantity: '3' }])

    const app = await buildApp()
    const res = await request(app)
      .get('/products')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.status).toBe(200)
    expect(res.body[0].variants[0]).toEqual(expect.objectContaining({ movingAverageCost: '400.00', currentStock: 3 }))
  })

  it('GET /products search matches every searchable variant identity field', async () => {
    productsFindManyMock
      .mockResolvedValueOnce([{ id: 'product-teal' }])
      .mockResolvedValueOnce([{
        id: 'product-teal',
        name: 'Cotton Kurta',
        category_id: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        variants: [{
          id: 'variant-teal', product_id: 'product-teal', sku: 'QA-KURTA-04', barcode: '890QA100003',
          unit_of_measure: 'piece', size: 'L', color: 'Teal', material: 'Cotton', price: '499.00',
          moving_average_cost: null, is_taxable: true, tax_rate: '0.05', reorder_threshold: '3',
          identity_locked: false, created_at: new Date('2026-01-01T00:00:00Z'),
        }],
      }])

    const app = await buildApp()
    const res = await request(app)
      .get('/products')
      .query({ search: 'Teal' })
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.status).toBe(200)
    expect(res.body[0].variants[0]).toMatchObject({ sku: 'QA-KURTA-04', color: 'Teal' })
    expect(productsFindManyMock.mock.calls[0][0].where.OR).toContainEqual({
      variants: { some: { barcode: { contains: 'Teal' } } },
    })
    expect(productsFindManyMock.mock.calls[0][0].where.OR).toContainEqual({
      variants: { some: { size: { contains: 'Teal', mode: 'insensitive' } } },
    })
    expect(productsFindManyMock.mock.calls[0][0].where.OR).toContainEqual({
      variants: { some: { color: { contains: 'Teal', mode: 'insensitive' } } },
    })
    expect(productsFindManyMock.mock.calls[0][0].where.OR).toContainEqual({
      variants: { some: { material: { contains: 'Teal', mode: 'insensitive' } } },
    })
  })
})
