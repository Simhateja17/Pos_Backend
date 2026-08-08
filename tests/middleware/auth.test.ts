import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock @supabase/supabase-js BEFORE importing the module under test, since
// auth.ts instantiates createClient() at module load time.
const getUserMock = vi.fn()
const membershipFindFirstMock = vi.fn()
const billingFindFirstMock = vi.fn()
const billingUpdateManyMock = vi.fn()
const terminalFindFirstMock = vi.fn()
const terminalUpdateManyMock = vi.fn()
const forTenantTransactionMock = vi.fn(async (_tenantId: string, callback: (tx: any) => Promise<unknown>) => callback({
  staff_members: { findFirst: membershipFindFirstMock },
  billing_subscriptions: {
    findFirst: billingFindFirstMock,
    updateMany: billingUpdateManyMock,
  },
  terminals: { findFirst: terminalFindFirstMock, updateMany: terminalUpdateManyMock },
  staff_sessions: { findFirst: vi.fn(), updateMany: vi.fn() },
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: getUserMock },
  }),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenantTransaction: forTenantTransactionMock,
}))

// Build a syntactically valid (but unsigned/fake) JWT string: header.payload.signature.
// authMiddleware never verifies the signature itself — it relies on
// supabase.auth.getUser(token) (mocked here) for verification, and only decodes
// the payload locally to read the custom `role`/`tenant_id` claims written by
// the Custom Access Token Hook.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    membershipFindFirstMock.mockReset()
    billingFindFirstMock.mockReset().mockResolvedValue(null)
    billingUpdateManyMock.mockReset()
    terminalFindFirstMock.mockReset().mockResolvedValue(null)
    terminalUpdateManyMock.mockReset()
    forTenantTransactionMock.mockClear()
    membershipFindFirstMock.mockImplementation(({ where }: { where: { role: string; user_id: string } }) => ({
      role: where.role,
      tenant_id: 'tenant-abc',
      user_id: where.user_id,
    }))
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const app = express()
    app.use(express.json())
    app.get('/whoami', authMiddleware, (req, res) => {
      res.json({ user: req.user })
    })
    app.post('/whoami', authMiddleware, (req, res) => {
      res.json({ user: req.user })
    })
    return app
  }

  it('Test 1: valid JWT populates req.user from verified claims and calls next()', async () => {
    const token = fakeJwt({ sub: 'user-123', role: 'manager', tenant_id: 'tenant-abc' })
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })

    const app = await buildApp()
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({ id: 'user-123', role: 'manager', tenantId: 'tenant-abc' })
    expect(forTenantTransactionMock).toHaveBeenCalledOnce()
  })

  it('uses Couture staff_role while preserving Supabase role=authenticated', async () => {
    const token = fakeJwt({
      sub: 'user-123',
      role: 'authenticated',
      staff_role: 'manager',
      tenant_id: 'tenant-abc',
    })
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })

    const app = await buildApp()
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({ id: 'user-123', role: 'manager', tenantId: 'tenant-abc' })
  })

  it('Test 2a: missing Authorization header returns 401 and does not run the route', async () => {
    const app = await buildApp()
    const res = await request(app).get('/whoami')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(getUserMock).not.toHaveBeenCalled()
  })

  it('Test 2b: invalid/expired token returns 401 and does not run the route', async () => {
    const token = fakeJwt({ sub: 'user-123', role: 'manager', tenant_id: 'tenant-abc' })
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'invalid token' } })

    const app = await buildApp()
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('Test 3: req.user.tenantId/role come only from JWT claims, never from a conflicting request body', async () => {
    const token = fakeJwt({ sub: 'user-123', role: 'manager', tenant_id: 'tenant-abc' })
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })

    const app = await buildApp()
    const res = await request(app)
      .post('/whoami')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'owner', tenantId: 'attacker-tenant' })

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({ id: 'user-123', role: 'manager', tenantId: 'tenant-abc' })
  })

  it('responds 403 when JWT has no role/tenant_id claims (no staff_members row yet)', async () => {
    const token = fakeJwt({ sub: 'user-123' })
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })

    const app = await buildApp()
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'No tenant membership found' })
  })

  it('does not treat Supabase role=authenticated as a Couture staff role', async () => {
    const token = fakeJwt({ sub: 'user-123', role: 'authenticated', tenant_id: 'tenant-abc' })
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })

    const app = await buildApp()
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'No tenant membership found' })
  })

  it('rejects a previously issued token after the current membership no longer matches its role', async () => {
    const token = fakeJwt({ sub: 'user-123', role: 'owner', tenant_id: 'tenant-abc' })
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    membershipFindFirstMock.mockResolvedValue(null)

    const app = await buildApp()
    const res = await request(app).get('/whoami').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'No tenant membership found' })
  })
})
