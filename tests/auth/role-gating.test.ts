import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { seedTwoTenants, cleanupSeed, KNOWN_TEST_PIN, type SeedResult } from '../fixtures/seed'
import { loginOtpFor } from '../fixtures/otp'
import { grantActiveSubscription } from '../fixtures/entitlement'
import { pairDeviceToTerminal } from '../fixtures/terminal'

/**
 * AUTH-02 integration proof, against the real running Express app (no
 * mocks): a cashier JWT/acting-identity is blocked (403) from a
 * manager+-gated route; a manager/owner JWT is permitted (200).
 *
 * The JWTs come from the app's own POST /api/auth/login using a real email
 * OTP, rather than a direct supabaseAnon.signInWithPassword call. That keeps
 * the fixture honest about how a token is actually obtained now that login is
 * OTP-based, and means these tests would notice if the login route stopped
 * issuing usable tokens.
 */
async function jwtViaLoginRoute(email: string): Promise<string> {
  const otp = await loginOtpFor(email)
  const res = await request(app).post('/api/auth/login').send({ email, otp })
  if (res.status !== 200) {
    throw new Error(`role-gating.test.ts: login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.session.accessToken
}

describe('Role gating (real running Express app, real Supabase Auth JWTs)', () => {
  let seed: SeedResult
  let ownerJwt: string
  let managerJwt: string
  let deviceCookie: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    // /api/members sits behind requireSubscription; without this the route
    // answers 402 and never reaches the role check under test.
    await grantActiveSubscription(seed.tenantA.id)
    // A cashier PIN switch is refused with 409 on an unpaired browser.
    ;({ deviceCookie } = await pairDeviceToTerminal(seed.tenantA.id, seed.tenantA.storeId))
    ownerJwt = await jwtViaLoginRoute(seed.tenantA.owner.email as string)
    managerJwt = await jwtViaLoginRoute(seed.tenantA.manager.email as string)
  }, 60000)

  afterAll(async () => {
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: manager and owner JWTs both get 200 on GET /api/members', async () => {
    const managerRes = await request(app)
      .get('/api/members')
      .set('Authorization', `Bearer ${managerJwt}`)
    expect(managerRes.status).toBe(200)

    const ownerRes = await request(app)
      .get('/api/members')
      .set('Authorization', `Bearer ${ownerJwt}`)
    expect(ownerRes.status).toBe(200)
  })

  it('Test 2: a PIN-switched cashier operator token is blocked (403) from GET /api/members, even riding an owner JWT', async () => {
    const switchRes = await request(app)
      .post('/api/terminal/pin/switch')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .send({ staffId: seed.tenantA.cashier.id, pin: KNOWN_TEST_PIN })

    expect(switchRes.status).toBe(200)
    const operatorToken = switchRes.body.operatorToken
    expect(typeof operatorToken).toBe('string')

    const res = await request(app)
      .get('/api/members')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .set('X-Operator-Token', operatorToken)

    expect(res.status).toBe(403)
  })
})
