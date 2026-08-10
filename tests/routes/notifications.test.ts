import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string) => ({ auth: { getUser: getUserMock } })),
}))

const notificationsFindManyMock = vi.fn()
const notificationsUpdateManyMock = vi.fn()
const storesFindManyMock = vi.fn()
const membershipFindFirstMock = vi.fn()

const OWN_STORE = '11111111-1111-4111-8111-111111111111'
const OTHER_STORE = '22222222-2222-4222-8222-222222222222'

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    staff_members: { findFirst: membershipFindFirstMock },
    stores: { findMany: storesFindManyMock },
  })),
  forTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) =>
    fn({
      staff_members: { findFirst: membershipFindFirstMock },
      billing_subscriptions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      terminals: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      staff_sessions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      notifications: { findMany: notificationsFindManyMock, updateMany: notificationsUpdateManyMock },
      stores: { findMany: storesFindManyMock },
    }),
  ),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager') {
  return fakeJwt({ sub: 'user-123', staff_role: role, tenant_id: 'tenant-abc' })
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    type: 'stock_low',
    title: 'Blue shirt is low',
    body: '2 left',
    link: null,
    read_at: null,
    created_at: new Date('2026-08-10T10:00:00Z'),
    store_id: OWN_STORE,
    ...overrides,
  }
}

describe('GET /notifications — per-shop alert routing (Phase 8 task 11)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    notificationsFindManyMock.mockReset()
    notificationsUpdateManyMock.mockReset()
    storesFindManyMock.mockReset().mockResolvedValue([
      { id: OWN_STORE, name: 'Andheri' },
      { id: OTHER_STORE, name: 'Bandra' },
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
    const { default: router } = await import('../../src/routes/notifications')
    const app = express()
    app.use(express.json())
    app.use('/notifications', authMiddleware, storeContextMiddleware, router)
    return app
  }

  it('Test 1: a manager is scoped to their own shop plus business-wide items', async () => {
    notificationsFindManyMock.mockResolvedValue([])
    const app = await buildApp()

    await request(app).get('/notifications').set('Authorization', `Bearer ${tokenFor('manager')}`)

    // Alerts about a shop they cannot act on are noise. The filter must be a
    // query predicate, not a post-filter — otherwise another shop's rows are
    // fetched and merely hidden.
    expect(notificationsFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ store_id: OWN_STORE }, { store_id: null }] },
      }),
    )
  })

  it('Test 2: an owner is not filtered', async () => {
    notificationsFindManyMock.mockResolvedValue([])
    const app = await buildApp()

    await request(app).get('/notifications').set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(notificationsFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    )
  })

  it('Test 3: the owner gets unread counts grouped by shop, busiest first', async () => {
    notificationsFindManyMock.mockResolvedValue([
      notification({ id: 'a', store_id: OTHER_STORE }),
      notification({ id: 'b', store_id: OTHER_STORE }),
      notification({ id: 'c', store_id: OWN_STORE }),
      notification({ id: 'd', store_id: null }),
    ])
    const app = await buildApp()

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.status).toBe(200)
    // "Bandra 2, Andheri 1" — the grouping that stops an owner with several
    // shops muting the panel within a week.
    expect(res.body.byStore).toEqual([
      { storeId: OTHER_STORE, storeName: 'Bandra', unreadCount: 2 },
      { storeId: OWN_STORE, storeName: 'Andheri', unreadCount: 1 },
    ])
    expect(res.body.businessWideUnreadCount).toBe(1)
    expect(res.body.unreadCount).toBe(4)
  })

  it('Test 4: a manager gets no byStore breakdown — it implies a scope they lack', async () => {
    notificationsFindManyMock.mockResolvedValue([notification()])
    const app = await buildApp()

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)

    expect(res.body.byStore).toEqual([])
  })

  it('Test 5: notifications carry their shop name, and business-wide ones carry null', async () => {
    notificationsFindManyMock.mockResolvedValue([
      notification({ id: 'a', store_id: OWN_STORE }),
      notification({ id: 'b', store_id: null, type: 'business_type_unset' }),
    ])
    const app = await buildApp()

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.body.notifications[0]).toMatchObject({ storeId: OWN_STORE, storeName: 'Andheri' })
    expect(res.body.notifications[1]).toMatchObject({ storeId: null, storeName: null })
  })

  it('Test 6: a manager marking read cannot clear another shop\'s alerts', async () => {
    const app = await buildApp()

    await request(app).post('/notifications/read').set('Authorization', `Bearer ${tokenFor('manager')}`)

    // Clearing another shop's unread alerts would hide a stockout from the
    // person responsible for it.
    expect(notificationsUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { read_at: null, OR: [{ store_id: OWN_STORE }, { store_id: null }] },
      }),
    )
  })

  it('Test 7: an owner marking read clears everything', async () => {
    const app = await buildApp()

    await request(app).post('/notifications/read').set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(notificationsUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { read_at: null } }),
    )
  })
})
