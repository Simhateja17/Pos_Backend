import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { app } from '../../src/server'
import { seedTwoTenants, cleanupSeed, KNOWN_TEST_PIN, type SeedResult } from '../fixtures/seed'
import { loginOtpFor } from '../fixtures/otp'
import { grantActiveSubscription } from '../fixtures/entitlement'
import { pairDeviceToTerminal } from '../fixtures/terminal'

/**
 * Reads a staff_members row via a bare PrismaClient against RLS_DATABASE_URL
 * (the restricted app_runtime role) — NOT via src/db/tenantClient.ts's
 * forTenant() helper — so the assertion is made through the same restricted
 * role the app itself runs as. set_config and the query share one
 * $transaction so the session-local setting survives the live project's
 * Supavisor transaction-mode pooler (same constraint documented in
 * rls-enforcement.test.ts).
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
 * The real way staff are added: the owner creates a counter profile and hands
 * over a four-digit PIN. No email, no invite, no Supabase Auth user — a
 * cashier is selected on the paired counter and authenticates with that PIN
 * alone (POST /members, `accessMode: 'pin'` in the UI, which is the default).
 *
 * This suite replaces an older invite-flow test that exercised
 * POST /members/invite. That endpoint still exists, but only as the secondary
 * "Email account" path for someone who signs in from outside the store — it
 * is not how cashiers are created, so proving it end-to-end was proving the
 * wrong thing.
 *
 * Sequential narrative: each `it` depends on state from the previous one.
 */
describe('Owner creates counter staff by PIN -> staff signs in at the counter', () => {
  let seed: SeedResult
  let ownerJwt: string
  let deviceCookie: string
  let ownerOperatorToken: string
  let createdStaffId: string
  const temporaryPin = '4821'

  beforeAll(async () => {
    seed = await seedTwoTenants()
    // /members and /terminal/pin/* both sit behind requireSubscription.
    await grantActiveSubscription(seed.tenantA.id)
    // A cashier PIN switch is refused with 409 on an unpaired browser.
    ;({ deviceCookie } = await pairDeviceToTerminal(seed.tenantA.id, seed.tenantA.storeId))

    const ownerEmail = seed.tenantA.owner.email as string
    const otp = await loginOtpFor(ownerEmail)
    const login = await request(app).post('/api/auth/login').send({ email: ownerEmail, otp })
    if (login.status !== 200) {
      throw new Error(`staff-pin-flow.test.ts: owner login failed: ${login.status} ${JSON.stringify(login.body)}`)
    }
    ownerJwt = login.body.session.accessToken

    // Once a browser is paired it is a shared register, not a back-office
    // session: the organisation JWT alone gets 423 REGISTER_LOCKED. The owner
    // must PIN in. 'management' rather than 'register' so this does not
    // displace whoever is operating the counter.
    const managementSwitch = await request(app)
      .post('/api/terminal/pin/switch')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .send({ staffId: seed.tenantA.owner.id, pin: KNOWN_TEST_PIN, sessionType: 'management' })
    if (managementSwitch.status !== 200) {
      throw new Error(
        `staff-pin-flow.test.ts: owner management PIN switch failed: ${managementSwitch.status} ${JSON.stringify(managementSwitch.body)}`,
      )
    }
    ownerOperatorToken = managementSwitch.body.operatorToken
  }, 90000)

  afterAll(async () => {
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: POST /members creates a counter-only cashier — no auth user, no email, PIN must be changed on first use', async () => {
    const res = await request(app)
      .post('/api/members')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .set('X-Operator-Token', ownerOperatorToken)
      .send({ name: 'Counter Cashier', role: 'cashier', temporaryPin })

    expect([200, 201]).toContain(res.status)
    createdStaffId = res.body.id
    expect(typeof createdStaffId).toBe('string')

    const row = await readStaffRowAsAppRuntime(seed.tenantA.id, createdStaffId)
    expect(row).not.toBeNull()
    // Counter staff exist only inside the POS — no Supabase Auth account.
    expect(row!.user_id).toBeNull()
    expect(row!.email).toBeNull()
    expect(row!.role).toBe('cashier')
    // A PIN handed over by the owner is a temporary credential, never a
    // long-term secret.
    expect(row!.pin_must_change).toBe(true)
  })

  it('Test 2: the new cashier is attributed to the shop the owner created them in (0042: one person, one shop)', async () => {
    const row = await readStaffRowAsAppRuntime(seed.tenantA.id, createdStaffId)

    // Regression guard: both /members handlers once omitted store_id entirely.
    // staff_members.store_id is NOT NULL with no default and — unlike the seven
    // tables the 0045 shim covers — no BEFORE INSERT trigger to fill it, so
    // every staff creation failed with a swallowed 500.
    expect(row!.store_id).toBe(seed.tenantA.storeId)
  })

  it('Test 3: the cashier signs in at the paired counter with the temporary PIN', async () => {
    const res = await request(app)
      .post('/api/terminal/pin/switch')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .send({ staffId: createdStaffId, pin: temporaryPin })

    expect(res.status).toBe(200)
    expect(typeof res.body.operatorToken).toBe('string')
    expect(res.body.staff.role).toBe('cashier')
  })

  it('Test 4: a wrong PIN is refused', async () => {
    const res = await request(app)
      .post('/api/terminal/pin/switch')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .send({ staffId: createdStaffId, pin: '0000' })

    expect(res.status).toBe(401)
  })

  it('Test 5: the new cashier appears on the tenant roster', async () => {
    // Test 3 signed the cashier in at this register, which supersedes the
    // owner's earlier management session — so the owner PINs back in rather
    // than reusing a token the counter has moved past.
    const backOffice = await request(app)
      .post('/api/terminal/pin/switch')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .send({ staffId: seed.tenantA.owner.id, pin: KNOWN_TEST_PIN, sessionType: 'management' })
    expect(backOffice.status).toBe(200)

    const res = await request(app)
      .get('/api/members')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('Cookie', deviceCookie)
      .set('X-Operator-Token', backOffice.body.operatorToken)

    expect(res.status).toBe(200)
    const ids = (res.body as Array<{ id: string }>).map((m) => m.id)
    expect(ids).toContain(createdStaffId)
  })
})
