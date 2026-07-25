import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * PUR-01's own cross-tenant isolation proof — same bare-PrismaClient /
 * app_runtime pattern as rls-enforcement.test.ts, applied to the new
 * `suppliers` table added by 0020_suppliers.sql.
 */
describe('Suppliers RLS enforcement (real Supabase project, app_runtime role)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let supplierAId: string
  let supplierBId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
    client = new PrismaClient({ adapter })

    const supplierA = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.suppliers.create({
        data: { tenant_id: seed.tenantA.id, name: 'Tenant A Supplier', lead_time_days: 5 },
      })
    })
    supplierAId = supplierA.id

    const supplierB = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantB.id}, true)`
      return tx.suppliers.create({
        data: { tenant_id: seed.tenantB.id, name: 'Tenant B Supplier', lead_time_days: 5 },
      })
    })
    supplierBId = supplierB.id
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: tenant A context set — findMany returns only tenant A suppliers, never tenant B', async () => {
    const rows = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.suppliers.findMany()
    })

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.tenant_id).toBe(seed.tenantA.id)
    expect(rows.map((r) => r.id)).not.toContain(supplierBId)
  })

  it('Test 2: tenant A context set, direct lookup of tenant B supplier by id — not found', async () => {
    const row = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.suppliers.findFirst({ where: { id: supplierBId } })
    })
    expect(row).toBeNull()
  })

  it('Test 3: tenant A context set, attempting to update tenant B supplier by id — updates zero rows', async () => {
    const result = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.suppliers.updateMany({ where: { id: supplierBId }, data: { is_active: false } })
    })
    expect(result.count).toBe(0)

    const stillActive = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantB.id}, true)`
      return tx.suppliers.findFirst({ where: { id: supplierBId } })
    })
    expect(stillActive?.is_active).toBe(true)
  })
})
