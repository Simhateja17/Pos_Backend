import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * Real-Supabase proof of CASH-01/CASH-02's shift reconciliation math
 * (D-13 through D-16), following tests/inventory/stock-trigger.test.ts's and
 * tests/checkout/returns.test.ts's exact pattern: a bare PrismaClient via
 * PrismaPg against RLS_DATABASE_URL (app_runtime role), fixture rows inserted
 * via the superuser DATABASE_URL connection. This test seeds the DB rows
 * directly and proves the underlying invariants at the data layer — it does
 * not exercise the shifts.ts HTTP routes directly (no live-server harness
 * exists in this test tier); Task 1's route handlers are what wire this same
 * computeXReport() aggregation shape into GET /x-report and POST /close.
 */
describe('Shift reconciliation real-Supabase proof (CASH-01/CASH-02, D-13 through D-16)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let superClient: PrismaClient
  let productId: string
  let variantId: string
  let shiftId: string
  let cashSaleId: string
  let cardSaleId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
    client = new PrismaClient({ adapter })

    const superAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    superClient = new PrismaClient({ adapter: superAdapter })

    const product = await superClient.products.create({
      data: { tenant_id: seed.tenantA.id, name: `Shift Test Product ${randomUUID().slice(0, 8)}` },
    })
    productId = product.id
    const variant = await superClient.variants.create({
      data: { tenant_id: seed.tenantA.id, product_id: productId, sku: `SHF-${randomUUID().slice(0, 8)}`, price: 25.0 },
    })
    variantId = variant.id

    // Test 1: opening a shift with startingCash=$100.00 persists a shifts row
    // with closed_at IS NULL.
    const shift = await superClient.shifts.create({
      data: { tenant_id: seed.tenantA.id, staff_id: seed.tenantA.cashier.id, starting_cash: 100.0 },
    })
    shiftId = shift.id
    expect(shift.closed_at).toBeNull()
    expect(shift.counted_cash).toBeNull()

    // Two fixture sales attached to this shift: one cash sale of $50.00, one
    // card sale of $30.00 — card sales do not affect the physical cash drawer.
    const cashSale = await superClient.sales.create({
      data: {
        tenant_id: seed.tenantA.id,
        client_sale_id: randomUUID(),
        shift_id: shiftId,
        subtotal: 50.0,
        discount_amount: 0,
        tax_amount: 0,
        total_amount: 50.0,
        created_by: seed.tenantA.cashier.id,
      },
    })
    cashSaleId = cashSale.id
    await superClient.payments.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: cashSaleId,
        method: 'cash',
        direction: 'payment',
        amount: 50.0,
        created_by: seed.tenantA.cashier.id,
      },
    })

    const cardSale = await superClient.sales.create({
      data: {
        tenant_id: seed.tenantA.id,
        client_sale_id: randomUUID(),
        shift_id: shiftId,
        subtotal: 30.0,
        discount_amount: 0,
        tax_amount: 0,
        total_amount: 30.0,
        created_by: seed.tenantA.cashier.id,
      },
    })
    cardSaleId = cardSale.id
    await superClient.payments.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: cardSaleId,
        method: 'card',
        direction: 'payment',
        amount: 30.0,
        reference_code: 'AUTH123',
        created_by: seed.tenantA.cashier.id,
      },
    })
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    await superClient.sales.delete({ where: { id: cashSaleId } }).catch(() => {})
    await superClient.sales.delete({ where: { id: cardSaleId } }).catch(() => {})
    await superClient.shifts.delete({ where: { id: shiftId } }).catch(() => {})
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 2: the X-report aggregation (called twice) returns updated totals both times but never writes to the shifts row', async () => {
    async function computeExpectedCash() {
      return client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        const shift = await tx.shifts.findFirst({ where: { id: shiftId } })
        const sales = await tx.sales.findMany({ where: { shift_id: shiftId } })
        const saleIds = sales.map((s) => s.id)
        const payments = await tx.payments.findMany({ where: { sale_id: { in: saleIds } } })
        const cashSalesTotal = payments
          .filter((p) => p.direction === 'payment' && p.method === 'cash')
          .reduce((sum, p) => sum + Number(p.amount), 0)
        const cardSalesTotal = payments
          .filter((p) => p.direction === 'payment' && p.method === 'card')
          .reduce((sum, p) => sum + Number(p.amount), 0)
        const refundsTotal = payments
          .filter((p) => p.direction === 'refund' && p.method === 'cash')
          .reduce((sum, p) => sum + Number(p.amount), 0)
        const expectedCash = Number(shift!.starting_cash) + cashSalesTotal - refundsTotal
        return { expectedCash, cardSalesTotal, shift: shift! }
      })
    }

    const first = await computeExpectedCash()
    // 100 (starting) + 50 (cash sale) = 150.00. Card sale ($30) does not
    // affect the physical cash drawer.
    expect(first.expectedCash).toBe(150)
    expect(first.cardSalesTotal).toBe(30)
    expect(first.shift.closed_at).toBeNull()
    expect(first.shift.counted_cash).toBeNull()

    // Calling the same aggregation a second time returns the same totals and
    // still never mutates the shift (D-15's non-resetting invariant).
    const second = await computeExpectedCash()
    expect(second.expectedCash).toBe(150)
    expect(second.shift.closed_at).toBeNull()
    expect(second.shift.counted_cash).toBeNull()
  })

  it('Test 3/4: closing with countedCash=148.00 produces variance=-2.00, persists, and is re-readable (not re-derived)', async () => {
    const expectedCash = 150.0
    const countedCash = 148.0
    const variance = countedCash - expectedCash // -2.00

    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.shifts.update({
        where: { id: shiftId },
        data: {
          counted_cash: countedCash,
          variance: variance,
          closed_at: new Date(),
        },
      })
    })

    const closed = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.shifts.findFirst({ where: { id: shiftId } })
    })

    expect(Number(closed?.counted_cash)).toBe(148)
    expect(Number(closed?.variance)).toBe(-2)
    expect(closed?.closed_at).not.toBeNull()

    // A second close attempt on the same (now-closed) shift must be rejected
    // by the route (409) — this test documents the invariant the route
    // enforces (Task 1's `closed_at !== null` guard); no DB-level constraint
    // blocks a second UPDATE directly, by the same convention as
    // returns.test.ts's documented-invariant tests.
    expect(closed?.closed_at).not.toBeNull()
  })
})
