import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'

const storesFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    stores: { findFirst: storesFindFirstMock },
  })),
}))

import {
  storeContextMiddleware,
  activeStoreId,
  storeScopeWhere,
} from '../../src/middleware/storeContext'

const OWN_STORE = '11111111-1111-4111-8111-111111111111'
const OTHER_STORE = '22222222-2222-4222-8222-222222222222'

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as Request
}

function mockRes(): Response {
  const res: any = {}
  res.status = vi.fn(() => res)
  res.json = vi.fn(() => res)
  return res as Response
}

function user(role: 'owner' | 'manager' | 'cashier') {
  return { id: 'u1', role, tenantId: 't1', storeId: OWN_STORE }
}

describe('storeContextMiddleware', () => {
  beforeEach(() => {
    storesFindFirstMock.mockReset()
  })

  it('Test 1: no X-Store-Id header -> acts in own store, not remotely', async () => {
    const req = mockReq({ user: user('cashier') })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.storeContext).toEqual({ scope: 'store', activeStoreId: OWN_STORE, actingRemotely: false })
    // Own store never costs a database lookup — that is the common path.
    expect(storesFindFirstMock).not.toHaveBeenCalled()
  })

  it('Test 2: header naming own store is accepted without a lookup', async () => {
    const req = mockReq({ user: user('manager'), headers: { 'x-store-id': OWN_STORE } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.storeContext?.actingRemotely).toBe(false)
    expect(storesFindFirstMock).not.toHaveBeenCalled()
  })

  it('PIN-switched staff membership wins over the durable owner session', async () => {
    const req = mockReq({
      user: user('owner'),
      actingStaff: { id: 'staff-manager', role: 'manager', storeId: OTHER_STORE },
    })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.storeContext).toEqual({
      scope: 'store',
      activeStoreId: OTHER_STORE,
      actingRemotely: false,
    })
  })

  it('PIN-switched manager cannot request business-wide scope from an owner session', async () => {
    const req = mockReq({
      user: user('owner'),
      headers: { 'x-store-id': 'all' },
      actingStaff: { id: 'staff-manager', role: 'manager', storeId: OTHER_STORE },
    })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it.each(['cashier', 'manager'] as const)(
    'Test 3: a %s naming another store is refused with 403',
    async (role) => {
      const req = mockReq({ user: user(role), headers: { 'x-store-id': OTHER_STORE } })
      const res = mockRes()
      const next = vi.fn()

      await storeContextMiddleware(req, res, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(next).not.toHaveBeenCalled()
      // Never even asks the database — non-owners are refused on membership alone.
      expect(storesFindFirstMock).not.toHaveBeenCalled()
    },
  )

  it('Test 4: an owner may act in another store of their own business', async () => {
    storesFindFirstMock.mockResolvedValue({ id: OTHER_STORE })
    const req = mockReq({ user: user('owner'), headers: { 'x-store-id': OTHER_STORE } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.storeContext).toEqual({ scope: 'store', activeStoreId: OTHER_STORE, actingRemotely: true })
  })

  it('Test 5: an owner naming a store outside their tenant is refused (RLS returns nothing)', async () => {
    // forTenant() scopes the lookup, so another business's store id simply does
    // not resolve — this is RLS refusing, not an app-layer string comparison.
    storesFindFirstMock.mockResolvedValue(null)
    const req = mockReq({ user: user('owner'), headers: { 'x-store-id': OTHER_STORE } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('Test 6: an owner cannot act in a deactivated store', async () => {
    // The route filters on is_active, so a deactivated store resolves to null.
    storesFindFirstMock.mockResolvedValue(null)
    const req = mockReq({ user: user('owner'), headers: { 'x-store-id': OTHER_STORE } })
    const res = mockRes()

    await storeContextMiddleware(req, res, mockRes as any)

    expect(storesFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_STORE, is_active: true } }),
    )
  })

  it('Test 7: a malformed store id is rejected before touching the database', async () => {
    const req = mockReq({ user: user('owner'), headers: { 'x-store-id': 'not-a-uuid' } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(storesFindFirstMock).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('Test 8: no authenticated user -> 401', async () => {
    const req = mockReq({ headers: { 'x-store-id': OTHER_STORE } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('activeStoreId', () => {
  it('throws rather than defaulting when the middleware was not mounted', () => {
    // A silent fallback here would mean reading or writing against an arbitrary
    // shop — the worst failure mode multi-store can produce.
    expect(() => activeStoreId(mockReq())).toThrow(/storeContextMiddleware must be mounted/)
  })

  it('returns the resolved store when the middleware ran', () => {
    const req = mockReq({
      storeContext: { scope: 'store', activeStoreId: OWN_STORE, actingRemotely: false },
    })
    expect(activeStoreId(req)).toBe(OWN_STORE)
  })

  it('throws under business scope rather than picking a shop to write to', () => {
    const req = mockReq({
      storeContext: { scope: 'business', activeStoreId: null, actingRemotely: false },
    })
    expect(() => activeStoreId(req)).toThrow(/business-wide scope/)
  })
})

describe('business-wide scope (X-Store-Id: all)', () => {
  it('an owner may request every shop combined', async () => {
    const req = mockReq({ user: user('owner'), headers: { 'x-store-id': 'all' } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.storeContext).toEqual({ scope: 'business', activeStoreId: null, actingRemotely: false })
    expect(storeScopeWhere(req)).toEqual({})
  })

  it.each(['manager', 'cashier'] as const)('a %s may not', async (role) => {
    const req = mockReq({ user: user(role), headers: { 'x-store-id': 'all' } })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('a PIN-switched manager may not request business-wide scope even when the JWT is owner', async () => {
    const req = mockReq({
      user: user('owner'),
      headers: { 'x-store-id': 'all' },
      actingStaff: { id: 'staff-manager', role: 'manager', storeId: OTHER_STORE },
    })
    const res = mockRes()
    const next = vi.fn()

    await storeContextMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('storeScopeWhere narrows to the store under store scope', () => {
    const req = mockReq({
      storeContext: { scope: 'store', activeStoreId: OWN_STORE, actingRemotely: false },
    })
    expect(storeScopeWhere(req)).toEqual({ store_id: OWN_STORE })
  })
})
