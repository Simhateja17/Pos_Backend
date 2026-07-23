import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../../src/server'
import { seedTwoTenants, cleanupSeed, KNOWN_TEST_PASSWORD, type SeedResult } from '../fixtures/seed'

/**
 * AUTH-01 integration proof: POST /api/auth/login against the real running
 * Express app and a real Supabase test project — no mocks anywhere in this
 * file.
 */
describe('POST /api/auth/login (real Supabase Auth)', () => {
  let seed: SeedResult

  beforeAll(async () => {
    seed = await seedTwoTenants()
  }, 60000)

  afterAll(async () => {
    await cleanupSeed(seed)
  }, 60000)

  it('valid manager credentials return 200 with the correct role and tenantId', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seed.tenantA.manager.email, password: KNOWN_TEST_PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('manager')
    expect(res.body.user.tenantId).toBe(seed.tenantA.id)
  })

  it('wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seed.tenantA.manager.email, password: 'definitely-the-wrong-password' })

    expect(res.status).toBe(401)
  })
})
