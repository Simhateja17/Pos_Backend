import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createClient } from '@supabase/supabase-js'
import { app } from '../../src/server'
import { seedTwoTenants, cleanupSeed, KNOWN_TEST_PASSWORD, KNOWN_TEST_PIN, type SeedResult } from '../fixtures/seed'

const supabaseAnon = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_ANON_KEY as string,
)

async function realJwtFor(email: string, password: string): Promise<string> {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password })
  if (error || !data?.session) {
    throw new Error(`role-gating.test.ts: real login failed for ${email}: ${error?.message}`)
  }
  return data.session.access_token
}

/**
 * AUTH-02 integration proof, against the real running Express app (no
 * mocks): a cashier JWT/acting-identity is blocked (403) from a
 * manager+-gated route; a manager/owner JWT is permitted (200).
 */
describe('Role gating (real running Express app, real Supabase Auth JWTs)', () => {
  let seed: SeedResult
  let ownerJwt: string
  let managerJwt: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    ownerJwt = await realJwtFor(seed.tenantA.owner.email as string, KNOWN_TEST_PASSWORD)
    managerJwt = await realJwtFor(seed.tenantA.manager.email as string, KNOWN_TEST_PASSWORD)
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
      .send({ staffId: seed.tenantA.cashier.id, pin: KNOWN_TEST_PIN })

    expect(switchRes.status).toBe(200)
    const operatorToken = switchRes.body.operatorToken
    expect(typeof operatorToken).toBe('string')

    const res = await request(app)
      .get('/api/members')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('X-Operator-Token', operatorToken)

    expect(res.status).toBe(403)
  })
})
