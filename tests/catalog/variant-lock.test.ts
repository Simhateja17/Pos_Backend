import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string) => ({ auth: { getUser: getUserMock } })),
}))

const variantsFindFirstMock = vi.fn()
const variantsUpdateMock = vi.fn()
const variantStockLevelsFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    variants: {
      findFirst: variantsFindFirstMock,
      update: variantsUpdateMock,
    },
    variant_stock_levels: {
      findFirst: variantStockLevelsFindFirstMock,
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

const lockedVariant = {
  id: 'variant-1',
  product_id: 'product-1',
  sku: 'BLUE-0001',
  size: 'M',
  color: 'Blue',
  material: null,
  price: '49.99',
  reorder_threshold: 4,
  identity_locked: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
}

describe('products routes — variant identity lock (CATALOG-01/D-04)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    variantsFindFirstMock.mockReset()
    variantsUpdateMock.mockReset()
    variantStockLevelsFindFirstMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: productsRouter } = await import('../../src/routes/products')
    const app = express()
    app.use(express.json())
    app.use('/products', authMiddleware, productsRouter)
    return app
  }

  it('Test 1: PATCH .../variants/:variantId changing size on a locked variant returns 409', async () => {
    variantsFindFirstMock.mockResolvedValue(lockedVariant)

    const app = await buildApp()
    const res = await request(app)
      .patch('/products/product-1/variants/variant-1')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ size: 'L' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'Variant identity is locked once stock has moved' })
    expect(variantsUpdateMock).not.toHaveBeenCalled()
  })

  it('Test 2: PATCH .../variants/:variantId changing only price on a locked variant succeeds (200)', async () => {
    variantsFindFirstMock.mockResolvedValue(lockedVariant)
    variantsUpdateMock.mockResolvedValue({ ...lockedVariant, price: '55.00' })
    variantStockLevelsFindFirstMock.mockResolvedValue({ variant_id: 'variant-1', quantity: 3 })

    const app = await buildApp()
    const res = await request(app)
      .patch('/products/product-1/variants/variant-1')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ price: 55 })

    expect(res.status).toBe(200)
    expect(res.body.price).toBe('55.00')
    expect(variantsUpdateMock).toHaveBeenCalled()
  })
})
