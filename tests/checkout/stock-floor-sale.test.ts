import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * Real-Supabase proof of D-17: "sale" stock movements are allowed to push
 * variant_stock_levels.quantity negative (never blocking a paying customer),
 * while "adjustment"/"transfer" movements remain floor-guarded exactly as
 * migration 0009 originally shipped (migration 0010 scopes the guard to
 * non-sale movement types only). Same bare-PrismaClient-against-
 * RLS_DATABASE_URL pattern as tests/inventory/stock-trigger.test.ts — a
 * mocked test can only prove the route calls stock_movements.create, not
 * that the DB trigger itself actually carves out `sale`.
 *
 * EXECUTION CAVEAT: this exec sandbox blocks direct outbound Postgres egress
 * (confirmed since 01-09/02-01/02-05/03-01) — this file type-checks cleanly
 * but must be run from an unrestricted-network environment to confirm pass/
 * fail against the real live Supabase project.
 */
describe('D-17 stock-floor-guard sale carve-out (real Supabase project, app_runtime role)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let superClient: PrismaClient
  let productId: string
  let variantId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
    client = new PrismaClient({ adapter })

    const superAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    superClient = new PrismaClient({ adapter: superAdapter })
    const product = await superClient.products.create({
      data: { tenant_id: seed.tenantA.id, name: `Floor Guard Test Product ${randomUUID().slice(0, 8)}` },
    })
    productId = product.id
    const variant = await superClient.variants.create({
      data: { tenant_id: seed.tenantA.id, product_id: productId, sku: `FLR-${randomUUID().slice(0, 8)}`, price: 10.0 },
    })
    variantId = variant.id
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: a `sale` movement on a variant with 0 recorded stock succeeds and pushes quantity negative', async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          variant_id: variantId,
          movement_type: 'sale',
          quantity_delta: -1,
        },
      })
    })

    const level = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } })
    })
    expect(level?.quantity).toBe(-1)
  })

  it('Test 2: an `adjustment` movement that would take the same variant further negative is still rejected by the floor guard', async () => {
    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        await tx.stock_movements.create({
          data: {
            tenant_id: seed.tenantA.id,
            variant_id: variantId,
            movement_type: 'adjustment',
            quantity_delta: -5,
            reason_code: 'count_correction',
          },
        })
      }),
    ).rejects.toThrow()
  })
})
