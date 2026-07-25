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

  /**
   * Fresh variant per test that needs an isolated balance. Tests 1/2/5 share
   * `variantId` because they assert a running balance across each other; the
   * sequence/concurrency tests below must not perturb it.
   */
  async function freshVariant(): Promise<string> {
    const variant = await superClient.variants.create({
      data: {
        tenant_id: seed.tenantA.id,
        product_id: productId,
        sku: `TRG-${randomUUID().slice(0, 8)}`,
        price: 10.0,
      },
    })
    return variant.id
  }

  /** Derived level and the raw ledger sum for a variant, read in one snapshot. */
  async function derivedAndLedger(vId: string): Promise<{ derived: number; ledger: number }> {
    return client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      const level = await tx.variant_stock_levels.findFirst({ where: { variant_id: vId } })
      const agg = await tx.stock_movements.aggregate({
        where: { variant_id: vId },
        _sum: { quantity_delta: true },
      })
      return { derived: level?.quantity ?? 0, ledger: agg._sum.quantity_delta ?? 0 }
    })
  }

  async function addMovement(
    vId: string,
    movementType: 'receive' | 'sale' | 'return' | 'adjustment',
    delta: number,
  ): Promise<void> {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          variant_id: vId,
          movement_type: movementType,
          quantity_delta: delta,
          // D-12: reason_code is required for adjustment and forbidden otherwise.
          reason_code: movementType === 'adjustment' ? 'count_correction' : null,
        },
      })
    })
  }

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

  // --- Phase 5 Task 1: every reorder number is computed from the derived level,
  // so prove derived == ledger sum across all movement types and under concurrency.

  it('Test 6: derived level equals the ledger sum after every step of a receive/sale/return/adjustment sequence', async () => {
    const vId = await freshVariant()
    const sequence: Array<[Parameters<typeof addMovement>[1], number]> = [
      ['receive', 100],
      ['sale', -12],
      ['return', 3],
      ['adjustment', -5],
      ['receive', 40],
      ['sale', -26],
    ]

    let running = 0
    for (const [movementType, delta] of sequence) {
      await addMovement(vId, movementType, delta)
      running += delta
      const { derived, ledger } = await derivedAndLedger(vId)
      expect(derived).toBe(running)
      expect(ledger).toBe(running)
    }
  }, 60000)

  it('Test 7: concurrent movements on one variant do not lose updates — derived still equals the ledger sum', async () => {
    const vId = await freshVariant()
    await addMovement(vId, 'receive', 100)

    // 20 simultaneous sales on the same variant. A read-then-write trigger
    // would lose updates here; the upsert's ON CONFLICT DO UPDATE re-reads the
    // row under its own lock, so every decrement must land.
    await Promise.all(Array.from({ length: 20 }, () => addMovement(vId, 'sale', -1)))

    const { derived, ledger } = await derivedAndLedger(vId)
    expect(derived).toBe(80)
    expect(ledger).toBe(80)
  }, 60000)

  /**
   * Test 8 and 9 assert the CORRECT behaviour of the 0009/0010 floor guard and
   * currently FAIL — `it.fails` passes while the bug is present and turns red
   * the moment it is fixed, so neither can be silently forgotten. Both were
   * reproduced against the live project; see
   * docs/reference/known-issues-phase-02.md ("Floor guard").
   */
  it.fails(
    'Test 8: a stock-increasing `receive` is accepted even when the balance is still negative afterwards',
    async () => {
      const vId = await freshVariant()
      await addMovement(vId, 'receive', 10)
      await addMovement(vId, 'sale', -60) // D-17: sale may push negative
      // -50 + 20 = -30: still negative, but a receipt ADDS stock and must never
      // be refused. The guard tests the resulting sign, not the direction, so a
      // partial receipt against an oversold variant is currently rejected.
      await addMovement(vId, 'receive', 20)

      const { derived, ledger } = await derivedAndLedger(vId)
      expect(derived).toBe(-30)
      expect(ledger).toBe(-30)
    },
    60000,
  )

  it.fails(
    'Test 9: concurrent adjustments cannot breach the zero floor',
    async () => {
      const vId = await freshVariant()
      await addMovement(vId, 'receive', 80)

      // 20 simultaneous -8 adjustments against a balance of 80. At most 10 may
      // succeed. The guard's `SELECT quantity INTO existing_qty` takes no row
      // lock, so concurrent transactions all read the same pre-value and pass.
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => addMovement(vId, 'adjustment', -8)),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)

      const { derived, ledger } = await derivedAndLedger(vId)
      expect(derived).toBe(0)
      expect(ledger).toBe(0)
      expect(derived).toBeGreaterThanOrEqual(0)
    },
    60000,
  )
})
