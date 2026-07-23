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

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, key: string) => {
    if (key === 'service-role-key') {
      return { auth: { admin: { createUser: createUserMock, deleteUser: deleteUserMock } } }
    }
    return { auth: { signInWithPassword: signInWithPasswordMock } }
  }),
}))

const tenantsCreateMock = vi.fn()
const staffMembersCreateMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { create: tenantsCreateMock },
    staff_members: { create: staffMembersCreateMock },
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
  })

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
    tenantsCreateMock.mockResolvedValue({ id: 'tenant-1', business_name: "Jane's Boutique" })
    staffMembersCreateMock.mockResolvedValue({
      id: 'staff-1',
      tenant_id: 'tenant-1',
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
      tenantId: 'tenant-1',
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
          tenant_id: 'tenant-1',
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
