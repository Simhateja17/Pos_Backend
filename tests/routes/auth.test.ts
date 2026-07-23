import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

// auth.ts instantiates two Supabase clients at module load: an admin client
// (service-role key, used only for auth.admin.createUser/deleteUser) and an
// anon-key client (used for auth.signInWithPassword on both signup's
// session-minting step and login). Mock createClient to hand back a distinct
// mock object depending on which key it was called with, so tests can assert
// on admin-only vs anon-only behavior independently.
const createUserMock = vi.fn()
const deleteUserMock = vi.fn()
const signInWithPasswordMock = vi.fn()
// authMiddleware (src/middleware/auth.ts) also calls createClient(anon key)
// and then supabase.auth.getUser(token) — same mock covers both this file's
// routes and the authMiddleware it now imports for POST /set-pin.
const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, key: string) => {
    if (key === 'service-role-key') {
      return { auth: { admin: { createUser: createUserMock, deleteUser: deleteUserMock } } }
    }
    return { auth: { signInWithPassword: signInWithPasswordMock, getUser: getUserMock } }
  }),
}))

const tenantsCreateMock = vi.fn()
const staffMembersCreateMock = vi.fn()
const staffMembersUpdateManyMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { create: tenantsCreateMock },
    staff_members: { create: staffMembersCreateMock, updateMany: staffMembersUpdateManyMock },
  })),
}))

const staffMembersFindFirstMock = vi.fn()

vi.mock('../../src/db/prisma', () => ({
  basePrisma: {
    staff_members: { findFirst: staffMembersFindFirstMock },
  },
}))

function validSignupBody() {
  return {
    email: 'owner@example.com',
    password: 'supersecret123',
    ownerName: 'Jane Owner',
    businessName: 'Jane\'s Boutique',
    addressLine1: '123 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
    taxId: '12-3456789',
  }
}

describe('POST /auth/signup and /auth/login', () => {
  beforeEach(() => {
    vi.resetModules()
    createUserMock.mockReset()
    deleteUserMock.mockReset()
    signInWithPasswordMock.mockReset()
    tenantsCreateMock.mockReset()
    staffMembersCreateMock.mockReset()
    staffMembersFindFirstMock.mockReset()
    staffMembersUpdateManyMock.mockReset()
    getUserMock.mockReset()
  })

  // authMiddleware only base64-decodes the payload segment locally (the
  // actual signature verification is supabase.auth.getUser, mocked above) —
  // this helper builds a syntactically-valid 3-segment JWT with a real
  // top-level role/tenant_id payload so decodeJwtPayload succeeds.
  function fakeJwt(payload: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.fake-signature`
  }

  async function buildApp() {
    const { default: authRouter } = await import('../../src/routes/auth')
    const app = express()
    app.use(express.json())
    app.use('/auth', authRouter)
    return app
  }

  it('Test 1: valid signup creates a Supabase Auth user, a tenants row, and an owner staff_members row, returning 201 with { user, session }', async () => {
    createUserMock.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'owner@example.com' } },
      error: null,
    })
    // Signup generates the new tenant's id up front (randomUUID()) and uses it
    // for both the tenants and staff_members inserts — echo it back so the
    // assertions below can verify tenant/staff rows share the same id without
    // hard-coding a UUID the route itself generates.
    tenantsCreateMock.mockImplementation((args: { data: { id: string; business_name: string } }) =>
      Promise.resolve({ id: args.data.id, business_name: args.data.business_name }),
    )
    staffMembersCreateMock.mockResolvedValue({
      id: 'staff-1',
      user_id: 'user-1',
      role: 'owner',
    })
    signInWithPasswordMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'owner@example.com' },
        session: { access_token: 'access-token-1', refresh_token: 'refresh-token-1' },
      },
      error: null,
    })

    const app = await buildApp()
    const res = await request(app).post('/auth/signup').send(validSignupBody())

    expect(res.status).toBe(201)
    expect(res.body.user).toEqual({
      id: 'user-1',
      email: 'owner@example.com',
      role: 'owner',
      tenantId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(res.body.session).toEqual({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
    })
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@example.com', password: 'supersecret123' }),
    )
    expect(tenantsCreateMock).toHaveBeenCalled()
    expect(staffMembersCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant_id: res.body.user.tenantId,
          user_id: 'user-1',
          role: 'owner',
        }),
      }),
    )
  })

  it('Test 2: signup with an email that already has a Supabase Auth account returns 409 with the UI-SPEC-exact copy', async () => {
    createUserMock.mockResolvedValue({
      data: { user: null },
      error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' },
    })

    const app = await buildApp()
    const res = await request(app).post('/auth/signup').send(validSignupBody())

    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'An account already exists with this email. Log in instead',
    })
    expect(tenantsCreateMock).not.toHaveBeenCalled()
  })

  it('Test 3a: login with valid credentials returns 200 with { user: { role, tenantId, ... }, session }', async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'owner@example.com' },
        session: { access_token: 'access-token-2', refresh_token: 'refresh-token-2' },
      },
      error: null,
    })
    staffMembersFindFirstMock.mockResolvedValue({
      id: 'staff-1',
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      role: 'owner',
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@example.com', password: 'supersecret123' })

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id: 'user-1',
      email: 'owner@example.com',
      role: 'owner',
      tenantId: 'tenant-1',
    })
    expect(res.body.session).toEqual({
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
    })
  })

  it('Test 3b: login with invalid credentials returns 401 { error: "Invalid email or password" }', async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@example.com', password: 'wrong-password' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid email or password' })
    expect(staffMembersFindFirstMock).not.toHaveBeenCalled()
  })
})

describe('POST /auth/set-pin', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    staffMembersUpdateManyMock.mockReset()
  })

  function fakeJwt(payload: Record<string, unknown>) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${header}.${body}.fake-signature`
  }

  async function buildApp() {
    const { default: authRouter } = await import('../../src/routes/auth')
    const app = express()
    app.use(express.json())
    app.use('/auth', authRouter)
    return app
  }

  const validToken = fakeJwt({ role: 'manager', tenant_id: 'tenant-1' })

  it('Test 1: an authenticated request with a valid 4-digit PIN bcrypt-hashes it and writes it to the caller\'s OWN staff_members row via forTenant(req.user.tenantId), resetting attempts/lock, responding 200 { ok: true }', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    staffMembersUpdateManyMock.mockResolvedValue({ count: 1 })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/set-pin')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ pin: '1234' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(staffMembersUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id: 'user-1' },
        data: expect.objectContaining({ pin_attempts: 0, pin_locked_until: null }),
      }),
    )
    const call = staffMembersUpdateManyMock.mock.calls[0][0]
    expect(call.data.pin_hash).toEqual(expect.any(String))
    expect(call.data.pin_hash).not.toBe('1234')
  })

  it('Test 2: a body failing SetPinSchema validation (e.g. non-4-digit pin) responds 400 and never reaches the DB write', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/set-pin')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ pin: 'abcd' })

    expect(res.status).toBe(400)
    expect(staffMembersUpdateManyMock).not.toHaveBeenCalled()
  })

  it('Test 3: a request with no valid session (authMiddleware 401s) never reaches the handler — the route is mounted behind authMiddleware', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'invalid token' } })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/set-pin')
      .send({ pin: '1234' })

    expect(res.status).toBe(401)
    expect(staffMembersUpdateManyMock).not.toHaveBeenCalled()
  })

  it('Test 4: the route never accepts a staffId/memberId from the request body to decide whose PIN to set — it always resolves via req.user.id, ignoring a client-supplied staffId', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    staffMembersUpdateManyMock.mockResolvedValue({ count: 1 })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/set-pin')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ pin: '1234', staffId: 'someone-elses-staff-id', memberId: 'someone-elses-staff-id' })

    expect(res.status).toBe(200)
    expect(staffMembersUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-1' } }),
    )
  })
})
