import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * Real-Supabase proof of INV-02: "Current stock level per variant is always
 * derived from the ledger via a database trigger, never edited directly."
 * A mocked test can only prove the route calls stock_movements.create — it
 * cannot prove the trigger actually fires or that the GRANT-level append-only
 * restriction is real. This deliberately mirrors rls-enforcement.test.ts's
 * pattern: a bare PrismaClient against RLS_DATABASE_URL (app_runtime role,
 * NOBYPASSRLS), no forTenant() import.
 */
describe('Stock ledger trigger + append-only enforcement (real Supabase project, app_runtime role)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let superClient: PrismaClient
  let productId: string
  let variantId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
    client = new PrismaClient({ adapter })

    // Fixture product/variant rows inserted via the superuser connection
    // (same pattern seed.ts itself uses for tenant/staff rows) since
    // app_runtime writes require set_config wrapping, and this file only
    // needs the fixture data to exist, not to prove app_runtime can create it
    // (products.ts's own mocked tests already cover that CRUD path).
    const superAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    superClient = new PrismaClient({ adapter: superAdapter })
    const product = await superClient.products.create({
      data: { tenant_id: seed.tenantA.id, name: `Trigger Test Product ${randomUUID().slice(0, 8)}` },
    })
    productId = product.id
    const variant = await superClient.variants.create({
      data: { tenant_id: seed.tenantA.id, product_id: productId, sku: `TRG-${randomUUID().slice(0, 8)}`, price: 10.0 },
    })
    variantId = variant.id
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: inserting a stock_movements row (receive, +10) trigger-derives variant_stock_levels.quantity to 10', async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          variant_id: variantId,
          movement_type: 'receive',
          quantity_delta: 10,
        },
      })
    })

    const level = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } })
    })
    expect(level?.quantity).toBe(10)
  })

  it('Test 2: a second movement (adjustment, -3) trigger-derives the running balance to 7, not a fresh overwrite', async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          variant_id: variantId,
          movement_type: 'adjustment',
          quantity_delta: -3,
          reason_code: 'count_correction',
        },
      })
    })

    const level = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } })
    })
    expect(level?.quantity).toBe(7)
  })

  it('Test 3: app_runtime cannot UPDATE variant_stock_levels directly — Postgres refuses (GRANT-level, not RLS)', async () => {
    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        await tx.$executeRaw`UPDATE public.variant_stock_levels SET quantity = 999 WHERE variant_id = ${variantId}::uuid`
      }),
    ).rejects.toThrow()
  })

  it('Test 4: app_runtime cannot UPDATE or DELETE stock_movements directly — append-only enforced at the GRANT level', async () => {
    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        await tx.$executeRaw`UPDATE public.stock_movements SET quantity_delta = 999 WHERE variant_id = ${variantId}::uuid`
      }),
    ).rejects.toThrow()

    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        await tx.$executeRaw`DELETE FROM public.stock_movements WHERE variant_id = ${variantId}::uuid`
      }),
    ).rejects.toThrow()
  })

  it('Test 5: identity_locked flips true on the variant after its first stock_movements insert (D-04)', async () => {
    const variant = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.variants.findFirst({ where: { id: variantId } })
    })
    expect(variant?.identity_locked).toBe(true)
  })
})
