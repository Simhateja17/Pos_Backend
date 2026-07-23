import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcrypt'

/**
 * Shared test fixtures for 01-09's real-Supabase integration tests. This is
 * the ONLY place in the test suite (besides ad-hoc verification reads inside
 * rls-enforcement.test.ts / invite-flow.test.ts) that touches DATABASE_URL
 * (the session-mode/superuser connection). That connection is acceptable
 * ONLY for test fixture setup/teardown — NEVER for app runtime code, which
 * exclusively uses RLS_DATABASE_URL/app_runtime via basePrisma/forTenant
 * (see backend/src/db/prisma.ts). Using the superuser connection here lets
 * fixture setup insert rows without needing app.tenant_id pre-configured,
 * mirroring exactly what 01-04's migration tooling already uses this
 * connection string for.
 */
const superAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const superPrisma = new PrismaClient({ adapter: superAdapter })

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

export const KNOWN_TEST_PASSWORD = 'Test-Fixture-Password-123!'
export const KNOWN_TEST_PIN = '1234'

export interface SeededStaff {
  id: string
  name: string
  role: 'owner' | 'manager' | 'cashier'
  userId: string | null
  email: string | null
  pin: string
}

export interface SeededTenant {
  id: string
  businessName: string
  owner: SeededStaff
  manager: SeededStaff
  cashier: SeededStaff
}

export interface SeedResult {
  tenantA: SeededTenant
  tenantB: SeededTenant
}

async function createAuthTestUser(email: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: KNOWN_TEST_PASSWORD,
    email_confirm: true,
  })
  if (error || !data?.user) {
    throw new Error(`seed.ts: failed to create Supabase Auth test user ${email}: ${error?.message}`)
  }
  return data.user.id
}

async function seedOneTenant(label: 'a' | 'b', runId: string): Promise<SeededTenant> {
  const tenantId = randomUUID()
  const businessName = `Test Shop ${label.toUpperCase()} ${runId}`

  await superPrisma.tenants.create({
    data: {
      id: tenantId,
      business_name: businessName,
      address_line1: '123 Test St',
      city: 'Testville',
      state: 'CA',
      postal_code: '90001',
      country: 'US',
    },
  })

  const pinHash = await bcrypt.hash(KNOWN_TEST_PIN, 10)

  const ownerEmail = `test-${label}-owner-${runId}@example.com`
  const ownerUserId = await createAuthTestUser(ownerEmail)
  const ownerRow = await superPrisma.staff_members.create({
    data: {
      tenant_id: tenantId,
      user_id: ownerUserId,
      name: `Owner ${label.toUpperCase()}`,
      role: 'owner',
      pin_hash: pinHash,
      is_active: true,
    },
  })

  const managerEmail = `test-${label}-manager-${runId}@example.com`
  const managerUserId = await createAuthTestUser(managerEmail)
  const managerRow = await superPrisma.staff_members.create({
    data: {
      tenant_id: tenantId,
      user_id: managerUserId,
      name: `Manager ${label.toUpperCase()}`,
      role: 'manager',
      pin_hash: pinHash,
      is_active: true,
    },
  })

  // Cashier is PIN-only (D-09/D-10) — no linked Supabase Auth user, no
  // email/password login path. user_id stays null, matching a real cashier
  // who never gets a real login, only PIN-switch on a shared terminal.
  const cashierRow = await superPrisma.staff_members.create({
    data: {
      tenant_id: tenantId,
      user_id: null,
      name: `Cashier ${label.toUpperCase()}`,
      role: 'cashier',
      pin_hash: pinHash,
      is_active: true,
    },
  })

  return {
    id: tenantId,
    businessName,
    owner: {
      id: ownerRow.id,
      name: ownerRow.name,
      role: 'owner',
      userId: ownerUserId,
      email: ownerEmail,
      pin: KNOWN_TEST_PIN,
    },
    manager: {
      id: managerRow.id,
      name: managerRow.name,
      role: 'manager',
      userId: managerUserId,
      email: managerEmail,
      pin: KNOWN_TEST_PIN,
    },
    cashier: {
      id: cashierRow.id,
      name: cashierRow.name,
      role: 'cashier',
      userId: null,
      email: null,
      pin: KNOWN_TEST_PIN,
    },
  }
}

/**
 * seedTwoTenants — creates tenantA and tenantB, each with a real
 * Supabase-Auth-linked owner and manager (for login.test.ts/role-gating.test.ts
 * to sign in as) and a PIN-only cashier, against the real live Supabase test
 * project. Runs are namespaced by a short random runId so repeated/parallel
 * test runs never collide on the same email addresses.
 */
export async function seedTwoTenants(): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8)
  const tenantA = await seedOneTenant('a', runId)
  const tenantB = await seedOneTenant('b', runId)
  return { tenantA, tenantB }
}

/**
 * cleanupSeed — deletes both tenants (cascade-deletes their staff_members
 * rows per the FK's `on delete cascade`) and the associated real Supabase
 * Auth test users, so repeated test runs never accumulate data in the live
 * project. Best-effort per resource — one failed delete never masks another.
 */
export async function cleanupSeed(seed: SeedResult): Promise<void> {
  for (const tenant of [seed.tenantA, seed.tenantB]) {
    for (const staff of [tenant.owner, tenant.manager, tenant.cashier]) {
      if (staff.userId) {
        await supabaseAdmin.auth.admin.deleteUser(staff.userId).catch(() => {})
      }
    }
    await superPrisma.tenants.delete({ where: { id: tenant.id } }).catch(() => {})
  }
}
