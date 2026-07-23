import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock @supabase/supabase-js BEFORE importing the module under test, since
// auth.ts instantiates createClient() at module load time.
const getUserMock = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: getUserMock },
  }),
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
})
