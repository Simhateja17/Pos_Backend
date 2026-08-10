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
const storesFindManyMock = vi.fn()
const levelsFindManyMock = vi.fn()
const membershipFindFirstMock = vi.fn()

const OWN_STORE = '11111111-1111-4111-8111-111111111111'
const OTHER_STORE = '22222222-2222-4222-8222-222222222222'
const THIRD_STORE = '33333333-3333-4333-8333-333333333333'
const VARIANT = '44444444-4444-4444-8444-444444444444'

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({ staff_members: { findFirst: membershipFindFirstMock } })),
  forTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) =>
    fn({
      staff_members: { findFirst: membershipFindFirstMock },
      billing_subscriptions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      terminals: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      staff_sessions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      variants: { findFirst: variantsFindFirstMock },
      stores: { findMany: storesFindManyMock },
      variant_stock_levels: { findMany: levelsFindManyMock },
    }),
  ),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier') {
  return fakeJwt({ sub: 'user-123', staff_role: role, tenant_id: 'tenant-abc' })
}

describe('GET /variants/:variantId/availability (Phase 8 task 11)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    variantsFindFirstMock.mockReset().mockResolvedValue({
      id: VARIANT,
      sku: 'BLUE-0001',
      products: { name: 'Blue Cotton Shirt' },
    })
    storesFindManyMock.mockReset().mockResolvedValue([
      { id: OWN_STORE, name: 'Andheri' },
      { id: OTHER_STORE, name: 'Bandra' },
      { id: THIRD_STORE, name: 'Dadar' },
    ])
    levelsFindManyMock.mockReset().mockResolvedValue([
      { store_id: OWN_STORE, quantity: '0.000' },
      { store_id: OTHER_STORE, quantity: '3.000' },
    ])
    membershipFindFirstMock.mockReset().mockImplementation(({ where }: { where: { role?: string } }) => ({
      role: where.role,
      tenant_id: 'tenant-abc',
      store_id: OWN_STORE,
    }))
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { storeContextMiddleware } = await import('../../src/middleware/storeContext')
    const { default: router } = await import('../../src/routes/availability')
    const app = express()
    app.use(express.json())
    app.use('/variants/:variantId/availability', authMiddleware, storeContextMiddleware, router)
    return app
  }

  it('Test 1: a CASHIER may ask — this is the point of being a chain', async () => {
    const app = await buildApp()
    const res = await request(app)
      .get(`/variants/${VARIANT}/availability`)
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)

    expect(res.status).toBe(200)
    expect(res.body.productName).toBe('Blue Cotton Shirt')
  })

  it('Test 2: own shop first, then fullest shelf first', async () => {
    const app = await buildApp()
    const res = await request(app)
      .get(`/variants/${VARIANT}/availability`)
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)

    // A cashier whose own shop is out wants to know who HAS it, so the
    // fullest shelf leads the rest — not alphabetical order.
    expect(res.body.stores.map((s: any) => s.storeName)).toEqual(['Andheri', 'Bandra', 'Dadar'])
    expect(res.body.stores[0].isOwnStore).toBe(true)
    expect(res.body.stores[1].quantity).toBe('3.000')
  })

  it('Test 3: a shop with no ledger row reads as 0, not as missing', async () => {
    const app = await buildApp()
    const res = await request(app)
      .get(`/variants/${VARIANT}/availability`)
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)

    const dadar = res.body.stores.find((s: any) => s.storeName === 'Dadar')
    // Never held one is genuinely zero on the shelf. Omitting the shop would
    // make it look like the lookup failed.
    expect(dadar).toMatchObject({ quantity: '0', isOwnStore: false })
  })

  it('Test 4: the response carries NO money or sales figures — the security property', async () => {
    const app = await buildApp()
    const res = await request(app)
      .get(`/variants/${VARIANT}/availability`)
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)

    // Another shop's takings are not a cashier's business. This asserts the
    // ABSENCE deliberately: adding a price or revenue field later would
    // silently widen what every cashier can read, and this test is what
    // should stop it.
    const forbidden = ['price', 'revenue', 'total', 'takings', 'margin', 'cost', 'sales']
    const serialised = JSON.stringify(res.body).toLowerCase()
    for (const field of forbidden) {
      expect(serialised).not.toContain(`"${field}`)
    }
    for (const store of res.body.stores) {
      expect(Object.keys(store).sort()).toEqual(['isOwnStore', 'quantity', 'storeId', 'storeName'])
    }
  })

  it('Test 5: a deactivated shop is not offered as somewhere to send a customer', async () => {
    const app = await buildApp()
    await request(app)
      .get(`/variants/${VARIANT}/availability`)
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)

    expect(storesFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true } }),
    )
  })

  it('Test 6: an unknown variant is 404, not an empty shop list', async () => {
    variantsFindFirstMock.mockResolvedValue(null)
    const app = await buildApp()
    const res = await request(app)
      .get(`/variants/${VARIANT}/availability`)
      .set('Authorization', `Bearer ${tokenFor('manager')}`)

    expect(res.status).toBe(404)
  })

  it('Test 7: a malformed variant id is rejected before touching the database', async () => {
    const app = await buildApp()
    const res = await request(app)
      .get('/variants/not-a-uuid/availability')
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)

    expect(res.status).toBe(400)
    expect(variantsFindFirstMock).not.toHaveBeenCalled()
  })
})
