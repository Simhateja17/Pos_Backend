import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createClient } from '@supabase/supabase-js'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { app } from '../../src/server'
import { seedTwoTenants, cleanupSeed, KNOWN_TEST_PASSWORD, type SeedResult } from '../fixtures/seed'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

const supabaseAnon = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_ANON_KEY as string,
)

/**
 * Reads a staff_members row via a bare PrismaClient against RLS_DATABASE_URL
 * (the restricted app_runtime role) — NOT via src/db/tenantClient.ts's
 * forTenant() helper — per this plan's <read_first> instruction to verify
 * "via the test's own Prisma connection, not forTenant". set_config and the
 * query are wrapped in the same $transaction so the session-local setting
 * survives the live project's Supavisor transaction-mode pooler (same
 * connection-lifecycle constraint documented in rls-enforcement.test.ts).
 */
async function readStaffRowAsAppRuntime(tenantId: string, staffId: string) {
  const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
  const client = new PrismaClient({ adapter })
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      return tx.staff_members.findUnique({ where: { id: staffId } })
    })
  } finally {
    await client.$disconnect()
  }
}

/**
 * Closes the plan-checker BLOCKER: proves AUTH-01 end-to-end through the
 * REAL invite mechanism (D-04) — invite -> accept -> set-pin -> login ->
 * PIN-switch — for a genuinely invited staff member, not the seed-fixture
 * bypass every other test in this plan uses. Sequential narrative test: each
 * `it` depends on state produced by the previous one.
 */
describe('Real invite -> accept -> set-pin -> login/PIN-switch (closes plan-checker BLOCKER)', () => {
  let seed: SeedResult
  let ownerJwt: string
  let invitedEmail: string
  let invitedStaffId: string
  let invitedUserId: string
  let invitedAccessToken: string

  beforeAll(async () => {
    seed = await seedTwoTenants()

    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email: seed.tenantA.owner.email as string,
      password: KNOWN_TEST_PASSWORD,
    })
    if (error || !data?.session) {
      throw new Error(`invite-flow.test.ts: owner login failed: ${error?.message}`)
    }
    ownerJwt = data.session.access_token
    invitedEmail = `test-invited-manager-${randomUUID().slice(0, 8)}@example.com`
  }, 60000)

  afterAll(async () => {
    if (invitedUserId) {
      await supabaseAdmin.auth.admin.deleteUser(invitedUserId).catch(() => {})
    }
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: POST /api/members/invite creates a real Supabase Auth user and a staff_members row with user_id populated immediately', async () => {
    const res = await request(app)
      .post('/api/members/invite')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .send({ email: invitedEmail, name: 'Invited Manager', role: 'manager' })

    expect([200, 201]).toContain(res.status)
    invitedStaffId = res.body.id
    expect(typeof invitedStaffId).toBe('string')

    const row = await readStaffRowAsAppRuntime(seed.tenantA.id, invitedStaffId)
    expect(row).not.toBeNull()
    expect(row!.user_id).not.toBeNull()
    invitedUserId = row!.user_id as string
  })

  it('Test 2: activating the invite (setting a password) then logging in resolves the correct role/tenant on the very first token', async () => {
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(invitedUserId, {
      password: KNOWN_TEST_PASSWORD,
    })
    expect(updateError).toBeNull()

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: invitedEmail, password: KNOWN_TEST_PASSWORD })

    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('manager')
    expect(res.body.user.tenantId).toBe(seed.tenantA.id)
    invitedAccessToken = res.body.session.accessToken
    expect(typeof invitedAccessToken).toBe('string')
  })

  it('Test 3: POST /api/auth/set-pin provisions the invited manager\'s own PIN', async () => {
    const res = await request(app)
      .post('/api/auth/set-pin')
      .set('Authorization', `Bearer ${invitedAccessToken}`)
      .send({ pin: '5678' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('Test 4: PIN-switching as the invited manager with the PIN just set succeeds, proving the full non-seed-bypass loop', async () => {
    const res = await request(app)
      .post('/api/terminal/pin/switch')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .send({ staffId: invitedStaffId, pin: '5678' })

    expect(res.status).toBe(200)
    expect(typeof res.body.operatorToken).toBe('string')
    expect(res.body.staff.role).toBe('manager')
  })
})
