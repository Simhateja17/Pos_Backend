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
const variantsCreateMock = vi.fn()
const variantsFindFirstMock = vi.fn()
// 0032: the create response resolves category names, so the read client needs
// the categories table too.
const categoriesFindManyMock = vi.fn(async () => [])
const categoriesFindFirstMock = vi.fn(async () => null)
const categoriesCreateMock = vi.fn(async () => ({ id: 'category-1' }))
const membershipFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    staff_members: { findFirst: membershipFindFirstMock },
    products: {
      create: productsCreateMock,
    },
    variants: {
      create: variantsCreateMock,
      findFirst: variantsFindFirstMock,
    },
    categories: {
      findMany: categoriesFindManyMock,
      findFirst: categoriesFindFirstMock,
      create: categoriesCreateMock,
    },
  })),
  // CR-02: POST /products now runs its writes through forTenantTransaction,
  // not forTenant() — the mock callback receives the same tx-shaped client
  // the real one passes into `fn`, so route behavior/tests are unaffected.
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

describe('products routes — SKU generation/override (CATALOG-02)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    productsCreateMock.mockReset()
    variantsCreateMock.mockReset()
    variantsFindFirstMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    membershipFindFirstMock.mockReset().mockImplementation(({ where }: { where: { role?: string } }) => ({
      role: where.role,
      tenant_id: 'tenant-abc',
    }))
    variantsFindFirstMock.mockResolvedValue(null) // no SKU collision by default
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: productsRouter } = await import('../../src/routes/products')
    const app = express()
    app.use(express.json())
    app.use('/products', authMiddleware, productsRouter)
    return app
  }

  it('Test 1: POST /products with an explicit sku keeps that exact value, not a generated one', async () => {
    productsCreateMock.mockResolvedValue({
      id: 'product-1',
      name: 'Custom Product',
      category: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })
    variantsCreateMock.mockResolvedValue({
      id: 'variant-1',
      product_id: 'product-1',
      sku: 'CUSTOM-01',
      size: null,
      color: null,
      material: null,
      price: '10.00',
      reorder_threshold: 4,
      identity_locked: false,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ name: 'Custom Product', variants: [{ sku: 'CUSTOM-01', price: 10 }] })

    expect(res.status).toBe(201)
    expect(res.body.variants[0].sku).toBe('CUSTOM-01')
    expect(variantsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sku: 'CUSTOM-01' }) }),
    )
  })

  it('Test 2: POST /products with two variants supplying the same explicit sku returns 400 before any DB write', async () => {
    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({
        name: 'Dup SKU Product',
        variants: [
          { sku: 'X-01', price: 5 },
          { sku: 'X-01', price: 6 },
        ],
      })

    expect(res.status).toBe(400)
    expect(productsCreateMock).not.toHaveBeenCalled()
  })

  it('Test 3: a DB-level SKU collision (P2002) on the second variant create returns 409', async () => {
    productsCreateMock.mockResolvedValue({
      id: 'product-2',
      name: 'Collision Product',
      category: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    })
    variantsCreateMock
      .mockResolvedValueOnce({
        id: 'variant-1',
        product_id: 'product-2',
        sku: 'Y-01',
        size: null,
        color: null,
        material: null,
        price: '5.00',
        reorder_threshold: 4,
        identity_locked: false,
        created_at: new Date('2026-01-01T00:00:00Z'),
      })
      .mockRejectedValueOnce({ code: 'P2002' })

    const app = await buildApp()
    const res = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({
        name: 'Collision Product',
        variants: [
          { sku: 'Y-01', price: 5 },
          { sku: 'Y-02', price: 6 },
        ],
      })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'A variant with that SKU already exists' })
  })
})
