import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'
import { loginOtpFor, WRONG_OTP } from '../fixtures/otp'

/**
 * AUTH-01 integration proof: POST /api/auth/login against the real running
 * Express app and a real Supabase test project — no mocks anywhere in this
 * file.
 *
 * Login is OTP-based: the route takes `{ email, otp }` and verifies the code
 * through `supabaseAnon.auth.verifyOtp`. The codes here are real ones minted
 * by the admin API (see ../fixtures/otp.ts), not fabricated values, so the
 * server-side verification path is genuinely exercised.
 */
describe('POST /api/auth/login (real Supabase Auth, real email OTP)', () => {
  let seed: SeedResult

  beforeAll(async () => {
    seed = await seedTwoTenants()
  }, 60000)

  afterAll(async () => {
    await cleanupSeed(seed)
  }, 60000)

  it('a valid OTP returns 200 with the correct role and tenantId', async () => {
    const email = seed.tenantA.manager.email as string
    const otp = await loginOtpFor(email)

    const res = await request(app).post('/api/auth/login').send({ email, otp })

    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('manager')
    expect(res.body.user.tenantId).toBe(seed.tenantA.id)
    expect(typeof res.body.session.accessToken).toBe('string')
  })

  it('a wrong OTP returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seed.tenantA.manager.email, otp: WRONG_OTP })

    expect(res.status).toBe(401)
  })

  it('an OTP that has already been spent returns 401 on reuse', async () => {
    const email = seed.tenantA.owner.email as string
    const otp = await loginOtpFor(email)

    const first = await request(app).post('/api/auth/login').send({ email, otp })
    expect(first.status).toBe(200)

    // Single-use is the property that stops a leaked code being replayed.
    const replay = await request(app).post('/api/auth/login').send({ email, otp })
    expect(replay.status).toBe(401)
  })

  it('a malformed body (no otp) is rejected as 400 by the schema, not 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seed.tenantA.manager.email })

    expect(res.status).toBe(400)
  })
})
