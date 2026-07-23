import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.INVITE_REDIRECT_URL = 'http://localhost:3000/accept-invite'

// authMiddleware instantiates its own createClient(url, anonKey) for
// getUser(); members.ts instantiates a separate admin createClient(url,
// serviceRoleKey) for inviteUserByEmail/deleteUser. Mock createClient to hand
// back a distinct mock object depending on which key it was called with, so
// tests can assert on admin-only vs anon-only behavior independently — same
// pattern as tests/routes/auth.test.ts.
const getUserMock = vi.fn()
const inviteUserByEmailMock = vi.fn()
const deleteUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, key: string) => {
    if (key === 'service-role-key') {
      return { auth: { admin: { inviteUserByEmail: inviteUserByEmailMock, deleteUser: deleteUserMock } } }
    }
    return { auth: { getUser: getUserMock } }
  }),
}))

const staffMembersFindManyMock = vi.fn()
const staffMembersCreateMock = vi.fn()
const staffMembersUpdateMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    staff_members: {
      findMany: staffMembersFindManyMock,
      create: staffMembersCreateMock,
      update: staffMembersUpdateMock,
    },
  })),
}))

// Build a syntactically valid (but unsigned/fake) JWT string: header.payload.signature.
// authMiddleware never verifies the signature itself — it relies on the
// (mocked) supabase.auth.getUser(token) for verification, only decoding the
// payload locally to read the custom role/tenant_id claims.
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier', tenantId = 'tenant-abc') {
  return fakeJwt({ sub: 'user-123', role, tenant_id: tenantId })
}

describe('members routes', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    inviteUserByEmailMock.mockReset()
    deleteUserMock.mockReset()
    staffMembersFindManyMock.mockReset()
    staffMembersCreateMock.mockReset()
    staffMembersUpdateMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: membersRouter } = await import('../../src/routes/members')
    const app = express()
    app.use(express.json())
    app.use('/members', authMiddleware, membersRouter)
    return app
  }

  it('Test 1: GET /members with manager/owner JWT returns 200 with the tenant staff list; cashier JWT returns 403', async () => {
    staffMembersFindManyMock.mockResolvedValue([
      {
        id: 'staff-1',
        name: 'Jane Owner',
        role: 'owner',
        is_active: true,
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
    ])

    const app = await buildApp()

    const managerRes = await request(app).get('/members').set('Authorization', `Bearer ${tokenFor('manager')}`)
    expect(managerRes.status).toBe(200)
    expect(managerRes.body).toEqual([
      {
        id: 'staff-1',
        name: 'Jane Owner',
        role: 'owner',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    const cashierRes = await request(app).get('/members').set('Authorization', `Bearer ${tokenFor('cashier')}`)
    expect(cashierRes.status).toBe(403)
  })

  it('Test 2: POST /members/invite with an owner JWT creates the Supabase invite and a staff_members row scoped to the caller tenant, with user_id populated immediately; manager/cashier JWTs return 403', async () => {
    inviteUserByEmailMock.mockResolvedValue({
      data: { user: { id: 'invited-user-1' } },
      error: null,
    })
    staffMembersCreateMock.mockResolvedValue({
      id: 'staff-2',
      name: 'New Manager',
      role: 'manager',
      is_active: true,
      created_at: new Date('2026-01-02T00:00:00Z'),
    })

    const app = await buildApp()

    const ownerRes = await request(app)
      .post('/members/invite')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ email: 'newmanager@example.com', name: 'New Manager', role: 'manager' })

    expect(ownerRes.status).toBe(201)
    expect(inviteUserByEmailMock).toHaveBeenCalledWith(
      'newmanager@example.com',
      expect.objectContaining({ redirectTo: expect.anything() }),
    )
    expect(staffMembersCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant_id: 'tenant-abc',
          user_id: 'invited-user-1',
          name: 'New Manager',
          role: 'manager',
          is_active: true,
        }),
      }),
    )

    const managerRes = await request(app)
      .post('/members/invite')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)
      .send({ email: 'x@example.com', name: 'X', role: 'cashier' })
    expect(managerRes.status).toBe(403)

    const cashierRes = await request(app)
      .post('/members/invite')
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)
      .send({ email: 'y@example.com', name: 'Y', role: 'cashier' })
    expect(cashierRes.status).toBe(403)
  })

  it('Test 3: tenant scoping comes exclusively from the verified JWT — a forged tenantId in params/body is never read', async () => {
    staffMembersFindManyMock.mockResolvedValue([])
    const app = await buildApp()

    await request(app)
      .get('/members')
      .set('Authorization', `Bearer ${tokenFor('owner', 'tenant-real')}`)

    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenCalledWith('tenant-real')

    // The route source itself never reads req.params.tenantId/req.body.tenantId
    // for scoping purposes — verified statically here as well as functionally
    // (forTenant is always called with the JWT-derived tenantId above).
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/routes/members.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/req\.params\.tenantId/)
    expect(source).not.toMatch(/req\.body\.tenantId/)
  })

  it('Test 4: the invite handler writes the mocked inviteUserByEmail response data.user.id as staff_members.create user_id', async () => {
    inviteUserByEmailMock.mockResolvedValue({
      data: { user: { id: 'distinct-invited-id-999' } },
      error: null,
    })
    staffMembersCreateMock.mockResolvedValue({
      id: 'staff-3',
      name: 'Another Cashier',
      role: 'cashier',
      is_active: true,
      created_at: new Date('2026-01-03T00:00:00Z'),
    })

    const app = await buildApp()
    await request(app)
      .post('/members/invite')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ email: 'cashier2@example.com', name: 'Another Cashier', role: 'cashier' })

    expect(staffMembersCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: 'distinct-invited-id-999' }),
      }),
    )
  })
})
