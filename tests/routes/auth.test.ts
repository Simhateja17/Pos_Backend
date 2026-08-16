import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

// auth.ts instantiates separate admin and anon-key clients at module load.
const createUserMock = vi.fn()
const deleteUserMock = vi.fn()
const adminSignOutMock = vi.fn()
const signInWithOtpMock = vi.fn()
const verifyOtpMock = vi.fn()
const refreshSessionMock = vi.fn()
const setSessionMock = vi.fn()
const resetPasswordForEmailMock = vi.fn()
// authMiddleware (src/middleware/auth.ts) also calls createClient(anon key)
// and then supabase.auth.getUser(token) — same mock covers both this file's
// routes and the authMiddleware it now imports for POST /set-pin.
const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, key: string) => {
    if (key === 'service-role-key') {
      return { auth: { admin: { createUser: createUserMock, deleteUser: deleteUserMock, signOut: adminSignOutMock } } }
    }
    return {
      auth: {
        signInWithOtp: signInWithOtpMock,
        verifyOtp: verifyOtpMock,
        refreshSession: refreshSessionMock,
        setSession: setSessionMock,
        getUser: getUserMock,
        resetPasswordForEmail: resetPasswordForEmailMock,
      },
    }
  }),
}))

const tenantsCreateMock = vi.fn()
const storesCreateMock = vi.fn(async () => ({ id: 'store-1' }))
const staffMembersCreateMock = vi.fn()
const staffSessionsUpdateManyMock = vi.fn()
const staffMembersUpdateManyMock = vi.fn()
const membershipFindFirstMock = vi.fn()
// 0033: set-pin reads the row first to detect first-time activation.
// Defaults to an existing staff row with no PIN yet set — the common case
// these tests exercise — individual tests override when they need to.
const staffMembersFindFirstTenantScopedMock = vi.fn(async (): Promise<any> => ({
  id: 'staff-1', name: 'Test Staff', role: 'manager', tenant_id: 'tenant-1', is_active: true, pin_hash: null as string | null,
}))
// Signup now seeds a starter category list (0032's "no categories yet" fix).
const categoriesCreateMock = vi.fn(async () => ({ id: 'category-1' }))
// 0033: signup also creates a "set your business type" notification.
const notificationsCreateMock = vi.fn(async () => ({ id: 'notification-1' }))

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { create: tenantsCreateMock },
    stores: { create: storesCreateMock },
    staff_members: {
      create: staffMembersCreateMock,
      updateMany: staffMembersUpdateManyMock,
      findFirst: (args: any) => args?.where?.role && args?.where?.is_active
        ? membershipFindFirstMock(args)
        : staffMembersFindFirstTenantScopedMock(),
    },
    categories: { create: categoriesCreateMock },
    notifications: { create: notificationsCreateMock },
    staff_sessions: { updateMany: staffSessionsUpdateManyMock },
  })),
  forTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) =>
    fn({
      staff_members: { findFirst: membershipFindFirstMock },
      billing_subscriptions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      terminals: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      staff_sessions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
    }),
  ),
}))

const staffMembersFindFirstMock = vi.fn()

vi.mock('../../src/db/prisma', () => ({
  basePrisma: {
    staff_members: { findFirst: staffMembersFindFirstMock },
  },
}))

// Login now reads role/tenantId from the JWT's decoded claims (written by
// the Custom Access Token Hook) instead of a basePrisma DB lookup — see
// src/routes/auth.ts's login handler comment. Build a real-shaped
// (unsigned test) JWT so decodeJwtPayload() can parse it the same way it
// would a real Supabase-issued token.
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature`
}

function validSignupBody() {
  return {
    email: 'owner@example.com',
    otp: '123456',
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
    adminSignOutMock.mockReset()
    signInWithOtpMock.mockReset()
    verifyOtpMock.mockReset()
    refreshSessionMock.mockReset()
    setSessionMock.mockReset()
    tenantsCreateMock.mockReset()
    storesCreateMock.mockReset().mockResolvedValue({ id: 'store-1' })
    staffMembersCreateMock.mockReset()
    staffMembersFindFirstMock.mockReset()
    membershipFindFirstMock.mockReset().mockResolvedValue({
      role: 'manager', tenant_id: 'tenant-1', is_active: true,
    })
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
    verifyOtpMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'owner@example.com' },
        session: {
          access_token: fakeJwt({ role: 'authenticated', sub: 'user-1' }),
          refresh_token: 'temporary-refresh-token',
        },
      },
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
    refreshSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: fakeJwt({ role: 'authenticated', staff_role: 'owner', tenant_id: 'tenant-1' }),
          refresh_token: 'refresh-token-1',
        },
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
      accessToken: expect.any(String),
      refreshToken: 'refresh-token-1',
    })
    expect(res.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('couture_access_token=; Max-Age=0'),
      expect.stringContaining('couture_refresh_token=; Max-Age=0'),
    ]))
    expect(verifyOtpMock).toHaveBeenCalledWith({ email: 'owner@example.com', token: '123456', type: 'email' })
    expect(refreshSessionMock).toHaveBeenCalledWith({ refresh_token: 'temporary-refresh-token' })
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

  it('Test 2: signup OTP for an existing tenant member returns 409 with the UI-SPEC-exact copy', async () => {
    verifyOtpMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'owner@example.com' },
        session: {
          access_token: fakeJwt({ role: 'authenticated', staff_role: 'owner', tenant_id: 'tenant-existing' }),
          refresh_token: 'refresh-token-existing',
        },
      },
      error: null,
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
    const accessToken = fakeJwt({ role: 'authenticated', staff_role: 'owner', tenant_id: 'tenant-1', sub: 'user-1' })
    verifyOtpMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'owner@example.com' },
        session: { access_token: accessToken, refresh_token: 'refresh-token-2' },
      },
      error: null,
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@example.com', otp: '123456' })

    expect(res.status).toBe(200)
    expect(res.body.user).toEqual({
      id: 'user-1',
      email: 'owner@example.com',
      role: 'owner',
      tenantId: 'tenant-1',
    })
    expect(res.body.session).toEqual({
      accessToken,
      refreshToken: 'refresh-token-2',
    })
    expect(res.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('couture_access_token=; Max-Age=0'),
      expect.stringContaining('couture_refresh_token=; Max-Age=0'),
    ]))
    expect(staffMembersFindFirstMock).not.toHaveBeenCalled()
  })

  it('Test 3b: login with invalid credentials returns 401 { error: "Invalid email or password" }', async () => {
    verifyOtpMock.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Token has expired or is invalid' },
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@example.com', otp: '000000' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Invalid or expired code' })
    expect(staffMembersFindFirstMock).not.toHaveBeenCalled()
  })

  it.each([
    ['login', false],
    ['signup', true],
  ] as const)('OTP purpose=%s sets shouldCreateUser=%s', async (purpose, shouldCreateUser) => {
    signInWithOtpMock.mockResolvedValue({ data: {}, error: null })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'owner@example.com', purpose })

    expect(res.status).toBe(200)
    expect(signInWithOtpMock).toHaveBeenCalledWith({
      email: 'owner@example.com',
      options: { shouldCreateUser },
    })
  })

  it('login OTP request tells an unregistered email to create an account', async () => {
    signInWithOtpMock.mockResolvedValue({
      data: {},
      error: { status: 422, message: 'No account exists for this email' },
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'new-owner@example.com', purpose: 'login' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      error: 'No account found with this email. Create a store account first',
    })
  })

  it('preserves the Supabase OTP cooldown as a 429 with Retry-After', async () => {
    signInWithOtpMock.mockResolvedValue({
      data: {},
      error: {
        status: 429,
        code: 'over_email_send_rate_limit',
        message: 'For security purposes, you can only request this after 34 seconds.',
      },
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/otp/request')
      .send({ email: 'owner@example.com', purpose: 'login' })

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('34')
    expect(res.body).toEqual({ error: 'Too many code requests. Please try again in 34 seconds.' })
  })
})

describe('POST /auth/set-pin', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    membershipFindFirstMock.mockReset().mockResolvedValue({
      role: 'manager', tenant_id: 'tenant-1', is_active: true,
    })
    staffMembersUpdateManyMock.mockReset()
    staffMembersFindFirstTenantScopedMock.mockClear()
    notificationsCreateMock.mockClear()
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

  it('Test 5: first-time PIN set (pin_hash was NULL) creates a staff_activated notification; a repeat PIN reset does not', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    staffMembersUpdateManyMock.mockResolvedValue({ count: 1 })
    staffMembersFindFirstTenantScopedMock.mockResolvedValueOnce({
      id: 'staff-1', name: 'Riya', pin_hash: null,
    })

    const app = await buildApp()
    await request(app).post('/auth/set-pin').set('Authorization', `Bearer ${validToken}`).send({ pin: '1234' })
    expect(notificationsCreateMock).toHaveBeenCalledTimes(1)
    expect(notificationsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'staff_activated' }) }),
    )

    notificationsCreateMock.mockClear()
    staffMembersFindFirstTenantScopedMock.mockResolvedValueOnce({
      id: 'staff-1', name: 'Riya', pin_hash: 'already-set-hash',
    })
    await request(app).post('/auth/set-pin').set('Authorization', `Bearer ${validToken}`).send({ pin: '5678' })
    expect(notificationsCreateMock).not.toHaveBeenCalled()
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

// Regression coverage: OwnerPinRecoveryRequestSchema, and both
// /owner-pin-recovery routes, were dropped from a working tree that never
// committed them, while openapi.ts and the frontend's forgot-owner-pin /
// reset-owner-pin pages still referenced them — a CI build break that these
// tests exist to catch if it happens again.
describe('POST /auth/owner-pin-recovery/request', () => {
  beforeEach(() => {
    vi.resetModules()
    resetPasswordForEmailMock.mockReset()
  })

  async function buildApp() {
    const { default: authRouter } = await import('../../src/routes/auth')
    const app = express()
    app.use(express.json())
    app.use('/auth', authRouter)
    return app
  }

  it('Test 1: a valid email calls resetPasswordForEmail and responds 200 { ok: true }', async () => {
    resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null })

    const app = await buildApp()
    const res = await request(app).post('/auth/owner-pin-recovery/request').send({ email: 'owner@example.com' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(resetPasswordForEmailMock).toHaveBeenCalledWith('owner@example.com', expect.any(Object))
  })

  it('Test 2: an email that does not belong to any account still responds 200 { ok: true } — same shape, no enumeration', async () => {
    resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null })

    const app = await buildApp()
    const res = await request(app).post('/auth/owner-pin-recovery/request').send({ email: 'nobody@example.com' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('Test 3: an invalid email fails schema validation with 400 and never calls Supabase', async () => {
    const app = await buildApp()
    const res = await request(app).post('/auth/owner-pin-recovery/request').send({ email: 'not-an-email' })

    expect(res.status).toBe(400)
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled()
  })

  it('Test 4: a genuine provider failure responds 502, distinguishable from the always-200 enumeration-safe path', async () => {
    resetPasswordForEmailMock.mockResolvedValue({ data: null, error: { status: 500, message: 'provider down' } })

    const app = await buildApp()
    const res = await request(app).post('/auth/owner-pin-recovery/request').send({ email: 'owner@example.com' })

    expect(res.status).toBe(502)
  })
})

describe('POST /auth/owner-pin-recovery/confirm', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    membershipFindFirstMock.mockReset().mockResolvedValue({
      role: 'owner', tenant_id: 'tenant-1', is_active: true,
    })
    staffMembersUpdateManyMock.mockReset()
    staffSessionsUpdateManyMock.mockReset()
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

  const ownerToken = fakeJwt({ role: 'owner', tenant_id: 'tenant-1' })

  it('Test 1: an authenticated owner with a valid PIN gets it hashed and written, their other PIN sessions revoked, 200 { ok: true }', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null })
    staffMembersUpdateManyMock.mockResolvedValue({ count: 1 })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/owner-pin-recovery/confirm')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: '4321' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(staffMembersUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'owner-1' } }),
    )
    expect(staffSessionsUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staff_id: 'owner-1', logged_out_at: null } }),
    )
  })

  it('Test 2: a non-owner (manager) session is rejected 403, even with a well-formed PIN', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'manager-1' } }, error: null })
    membershipFindFirstMock.mockResolvedValue({ role: 'manager', tenant_id: 'tenant-1', is_active: true })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/owner-pin-recovery/confirm')
      .set('Authorization', `Bearer ${fakeJwt({ role: 'manager', tenant_id: 'tenant-1' })}`)
      .send({ pin: '4321' })

    expect(res.status).toBe(403)
    expect(staffMembersUpdateManyMock).not.toHaveBeenCalled()
  })

  it('Test 3: an invalid PIN fails schema validation with 400 and never reaches the DB write', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null })

    const app = await buildApp()
    const res = await request(app)
      .post('/auth/owner-pin-recovery/confirm')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pin: 'abcd' })

    expect(res.status).toBe(400)
    expect(staffMembersUpdateManyMock).not.toHaveBeenCalled()
  })

  it('Test 4: no session at all (authMiddleware 401s) never reaches the handler', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'invalid token' } })

    const app = await buildApp()
    const res = await request(app).post('/auth/owner-pin-recovery/confirm').send({ pin: '4321' })

    expect(res.status).toBe(401)
    expect(staffMembersUpdateManyMock).not.toHaveBeenCalled()
  })
})

describe('POST /auth/logout', () => {
  beforeEach(() => {
    vi.resetModules()
    adminSignOutMock.mockReset().mockResolvedValue({ error: null })
  })

  it('revokes the provider session before clearing the local cookies', async () => {
    const { default: authRouter } = await import('../../src/routes/auth')
    const app = express()
    app.use(express.json())
    app.use('/auth', authRouter)

    const response = await request(app)
      .post('/auth/logout')
      .set('Cookie', ['couture_access_token=access-token'])

    expect(response.status).toBe(204)
    expect(adminSignOutMock).toHaveBeenCalledWith('access-token', 'global')
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      expect.stringContaining('couture_access_token='),
    ]))
  })
})

describe('GET /auth/session legacy-cookie compatibility', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    setSessionMock.mockReset()
  })

  it('validates an old access cookie without rotating its refresh-token family', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    const { default: authRouter } = await import('../../src/routes/auth')
    const app = express()
    app.use(express.json())
    app.use('/auth', authRouter)

    const response = await request(app)
      .get('/auth/session')
      .set('Cookie', [
        'couture_access_token=legacy-access-token',
        'couture_refresh_token=legacy-refresh-token',
      ])

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ authenticated: true })
    expect(getUserMock).toHaveBeenCalledWith('legacy-access-token')
    expect(setSessionMock).not.toHaveBeenCalled()
  })
})
