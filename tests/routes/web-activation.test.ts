import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret'

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  generateLink: vi.fn(),
  sendActivationEmail: vi.fn(),
  tenantFindFirst: vi.fn(),
}))

// auth.ts creates its clients at import time, before this file's env values
// apply (imports are hoisted), so the mock cannot branch on the key.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { admin: { getUserById: mocks.getUserById, generateLink: mocks.generateLink } } })),
}))

// The identity is what authMiddleware would have verified from the JWT.
vi.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', role: req.headers['x-test-role'] ?? 'owner', tenantId: 'tenant-1', storeId: 'store-1' }
    next()
  },
  decodeJwtPayload: vi.fn(),
  getStaffRoleClaim: vi.fn(),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({ tenants: { findFirst: mocks.tenantFindFirst } })),
}))

vi.mock('../../src/lib/activationEmail', () => ({ sendActivationEmail: mocks.sendActivationEmail }))

// vi.mock calls above are hoisted, so this import sees the mocks.
import authRouter, { resetActivationEmailCooldown } from '../../src/routes/auth'

function app() {
  const server = express()
  server.use(express.json())
  server.use('/auth', authRouter)
  server.use((error: unknown, _req: any, res: any, _next: any) => {
    console.error('[web-activation.test] unhandled route error', error)
    res.status(500).json({ error: 'unhandled' })
  })
  return server
}

describe('POST /auth/web-activation/email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetActivationEmailCooldown()
    process.env.WEB_APP_URL = 'https://in.ambelpos.com/anything'
    mocks.getUserById.mockResolvedValue({ data: { user: { email: 'owner@shop.in' } }, error: null })
    mocks.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'hashed/token+1' } }, error: null })
    mocks.sendActivationEmail.mockResolvedValue({ ok: true })
    mocks.tenantFindFirst.mockResolvedValue({ country: 'IN' })
  })

  it('emails a fragment-borne single-use link and never returns the token', async () => {
    const response = await request(app()).post('/auth/web-activation/email')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, sentTo: 'ow***@shop.in' })
    expect(JSON.stringify(response.body)).not.toContain('hashed')
    expect(mocks.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'owner@shop.in' })
    expect(mocks.sendActivationEmail).toHaveBeenCalledWith({
      to: 'owner@shop.in',
      activationUrl: 'https://in.ambelpos.com/activate#token_hash=hashed%2Ftoken%2B1&region=IN',
    })
  })

  it('labels international tenants so the web opens the INTL plans', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ country: 'US' })
    await request(app()).post('/auth/web-activation/email')
    expect(mocks.sendActivationEmail.mock.calls[0][0].activationUrl).toMatch(/&region=INTL$/)
  })

  it('refuses non-owners', async () => {
    const response = await request(app()).post('/auth/web-activation/email').set('x-test-role', 'manager')
    expect(response.status).toBe(403)
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('enforces a cooldown between emails', async () => {
    await request(app()).post('/auth/web-activation/email')
    const second = await request(app()).post('/auth/web-activation/email')
    expect(second.status).toBe(429)
    expect(second.body.error?.code ?? second.body.code).toBe('RATE_LIMITED')
    expect(second.headers['retry-after']).toBeDefined()
    expect(mocks.sendActivationEmail).toHaveBeenCalledTimes(1)
  })

  it('reports a provider failure and does not start the cooldown', async () => {
    mocks.sendActivationEmail.mockResolvedValueOnce({ ok: false, error: 'down' })
    const failed = await request(app()).post('/auth/web-activation/email')
    expect(failed.status).toBe(502)
    const retry = await request(app()).post('/auth/web-activation/email')
    expect(retry.status).toBe(200)
  })

  it('does not issue a link when the web origin is not configured', async () => {
    delete process.env.WEB_APP_URL
    const response = await request(app()).post('/auth/web-activation/email')
    expect(response.status).toBe(503)
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })
})
