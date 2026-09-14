import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * Real-Supabase proof of the explicit negative-stock opt-in: a `sale`
 * movement may push variant_stock_levels.quantity negative only when the
 * merchant has set allow_negative_stock=true. Tracked variants with that flag
 * off are rejected by the database trigger, while "adjustment"/"transfer"
 * movements remain floor-guarded. Same bare-PrismaClient-against-
 * RLS_DATABASE_URL pattern as tests/inventory/stock-trigger.test.ts — a
 * mocked test can only prove the route calls stock_movements.create, not
 * that the DB trigger itself actually carves out `sale`.
 *
 * EXECUTION CAVEAT: this exec sandbox blocks direct outbound Postgres egress
 * (confirmed since 01-09/02-01/02-05/03-01) — this file type-checks cleanly
 * but must be run from an unrestricted-network environment to confirm pass/
 * fail against the real live Supabase project.
 */
describe('stock-floor policy (real Supabase project, app_runtime role)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let superClient: PrismaClient
  let productId: string
  let variantId: string
  let strictVariantId: string | undefined

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
      data: {
        tenant_id: seed.tenantA.id,
        product_id: productId,
        sku: `FLR-${randomUUID().slice(0, 8)}`,
        price: 10.0,
        allow_negative_stock: true,
      },
    })
    variantId = variant.id
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    if (strictVariantId) await superClient.variants.delete({ where: { id: strictVariantId } }).catch(() => {})
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1: an opted-in `sale` movement on a variant with 0 recorded stock pushes quantity negative', async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          store_id: seed.tenantA.storeId,
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
    // quantity is numeric(12,3) -> Prisma Decimal, never a JS number.
    expect(Number(level?.quantity)).toBe(-1)
  })

  it('Test 2: a tracked sale with negative stock disabled is rejected by the database floor guard', async () => {
    const strictVariant = await superClient.variants.create({
      data: {
        tenant_id: seed.tenantA.id,
        product_id: productId,
        sku: `FLR-STRICT-${randomUUID().slice(0, 8)}`,
        price: 10.0,
        allow_negative_stock: false,
      },
    })
    strictVariantId = strictVariant.id

    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        await tx.stock_movements.create({
          data: {
            tenant_id: seed.tenantA.id,
            store_id: seed.tenantA.storeId,
            variant_id: strictVariant.id,
            movement_type: 'sale',
            quantity_delta: -1,
          },
        })
      }),
    ).rejects.toThrow()
  })

  it('Test 3: an `adjustment` movement that would take the same variant further negative is still rejected by the floor guard', async () => {
    await expect(
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        await tx.stock_movements.create({
          data: {
            tenant_id: seed.tenantA.id,
            store_id: seed.tenantA.storeId,
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
