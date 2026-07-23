import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * The literal, non-negotiable proof of Phase 1 success criterion #2:
 * "Postgres itself refuses a cross-tenant read — proven by a test — even
 * if the app-layer filter is bypassed."
 *
 * This file deliberately does NOT import forTenant from
 * ../../src/db/tenantClient — it constructs its own bare PrismaClient
 * against RLS_DATABASE_URL (the restricted app_runtime role, NOBYPASSRLS)
 * to prove the DATABASE itself enforces tenant isolation, independent of any
 * app-layer helper.
 */
describe('RLS enforcement (real Supabase project, app_runtime role, no forTenant())', () => {
  let seed: SeedResult
  let client: PrismaClient

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
    client = new PrismaClient({ adapter })
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: no tenant context set at all — findMany returns zero rows (default-deny)', async () => {
    // No set_config call anywhere before this query — current_setting(
    // 'app.tenant_id', true) is NULL for this fresh connection, and
    // `tenant_id = NULL` is never true under RLS's USING clause.
    const rows = await client.staff_members.findMany({
      where: {
        id: { in: [seed.tenantA.owner.id, seed.tenantA.manager.id, seed.tenantA.cashier.id] },
      },
    })
    expect(rows).toHaveLength(0)
  })

  it('Test 2: tenant A context set — only tenant A rows returned, never tenant B', async () => {
    // set_config and the query must run against the SAME underlying Postgres
    // connection for the session-local setting to be visible to the query
    // (the live project's RLS_DATABASE_URL is a Supavisor TRANSACTION-mode
    // pooler, which can hand out a different physical connection per
    // statement outside of an explicit transaction) — so this wraps both in
    // a single $transaction, exactly the connection-lifecycle constraint
    // backend/src/db/tenantClient.ts's forTenant() itself has to solve, just
    // written directly here instead of importing that helper.
    const rows = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.staff_members.findMany()
    })

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.tenant_id).toBe(seed.tenantA.id)
    }
    const returnedIds = rows.map((row) => row.id)
    expect(returnedIds).not.toContain(seed.tenantB.owner.id)
    expect(returnedIds).not.toContain(seed.tenantB.manager.id)
    expect(returnedIds).not.toContain(seed.tenantB.cashier.id)
  })

  it('Test 3: tenant A context set, direct lookup of a real tenant B row by its own id — not found', async () => {
    const row = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.staff_members.findFirst({ where: { id: seed.tenantB.owner.id } })
    })

    expect(row).toBeNull()
  })
})
