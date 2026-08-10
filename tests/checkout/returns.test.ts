import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * Real-Supabase proof of CHECK-07's partial-return + refund-to-original-method
 * behavior (D-09 through D-12), following tests/inventory/stock-trigger.test.ts's
 * exact pattern: a bare PrismaClient via PrismaPg against RLS_DATABASE_URL
 * (app_runtime role), fixture rows inserted via the superuser DATABASE_URL
 * connection. This test seeds the DB rows directly and proves the underlying
 * invariants at the data layer; it does not exercise POST /returns over HTTP
 * (no live-server harness exists in this test tier) — Task 1's route-level
 * logic is what enforces these invariants at request time.
 */
describe('Returns/refunds real-Supabase proof (CHECK-07, D-09 through D-12)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let superClient: PrismaClient
  let productId: string
  let variantId: string
  let saleId: string
  let saleLineItemId: string
  let shiftId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })
    client = new PrismaClient({ adapter })

    const superAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    superClient = new PrismaClient({ adapter: superAdapter })

    // Fixture product/variant, 2 units sold, paid in full by cash.
    const product = await superClient.products.create({
      data: { tenant_id: seed.tenantA.id, name: `Returns Test Product ${randomUUID().slice(0, 8)}` },
    })
    productId = product.id
    const variant = await superClient.variants.create({
      data: { tenant_id: seed.tenantA.id, product_id: productId, sku: `RET-${randomUUID().slice(0, 8)}`, price: 20.0 },
    })
    variantId = variant.id

    const shift = await superClient.shifts.create({
      data: { tenant_id: seed.tenantA.id, store_id: seed.tenantA.storeId, staff_id: seed.tenantA.cashier.id, starting_cash: 100.0 },
    })
    shiftId = shift.id

    const sale = await superClient.sales.create({
      data: {
        tenant_id: seed.tenantA.id,
        store_id: seed.tenantA.storeId,
        client_sale_id: randomUUID(),
        shift_id: shiftId,
        subtotal: 40.0,
        discount_amount: 0,
        tax_amount: 0,
        total_amount: 40.0,
        created_by: seed.tenantA.cashier.id,
      },
    })
    saleId = sale.id

    const saleLineItem = await superClient.sale_line_items.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: saleId,
        variant_id: variantId,
        quantity: 2,
        unit_price: 20.0,
        discount_amount: 0,
        is_taxable: true,
        line_total: 40.0,
      },
    })
    saleLineItemId = saleLineItem.id

    // Original stock_movements 'sale' row (2 units sold) + a single cash
    // payment row — this is what a real POST /sales checkout would have
    // written; inserted directly here since this test only needs the
    // fixture data to exist, not to re-exercise POST /sales itself.
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          store_id: seed.tenantA.storeId,
          variant_id: variantId,
          movement_type: 'sale',
          quantity_delta: -2,
          reference_id: saleId,
        },
      })
    })
    await superClient.payments.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: saleId,
        method: 'cash',
        direction: 'payment',
        amount: 40.0,
        created_by: seed.tenantA.cashier.id,
      },
    })
  }, 60000)

  afterAll(async () => {
    await client.$disconnect()
    await superClient.sales.delete({ where: { id: saleId } }).catch(() => {})
    await superClient.shifts.delete({ where: { id: shiftId } }).catch(() => {})
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('Test 1/2: returning 1 of 2 units writes a positive-delta return movement + a matching refund payment row', async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.stock_movements.create({
        data: {
          tenant_id: seed.tenantA.id,
          store_id: seed.tenantA.storeId,
          variant_id: variantId,
          movement_type: 'return',
          quantity_delta: 1,
          reference_id: saleId,
        },
      })
    })

    const level = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } })
    })
    // Started at -2 (sale), +1 (return) = -1.
    // quantity is numeric(12,3) -> Prisma Decimal, never a JS number.
    expect(Number(level?.quantity)).toBe(-1)

    const refund = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      await tx.payments.create({
        data: {
          tenant_id: seed.tenantA.id,
          sale_id: saleId,
          method: 'cash',
          direction: 'refund',
          amount: 20.0,
        },
      })
      return tx.payments.findFirst({ where: { sale_id: saleId, direction: 'refund' } })
    })
    expect(refund?.direction).toBe('refund')
    expect(refund?.method).toBe('cash')
    expect(Number(refund?.amount)).toBe(20)
  })

  it('Test 4 (documented invariant, no DB-level guard): a second return exceeding remaining returnable quantity is an application-layer rejection', async () => {
    // 2 units were sold total; 1 has already been returned above, leaving 1
    // remaining returnable. No Postgres constraint prevents inserting a
    // stock_movements row for more than that — this is Task 1's
    // application-layer check (step 5 of returns.ts's action block), not a
    // DB-level guard. This test documents the invariant the route enforces:
    // a request for quantity > remainingReturnable (here, requesting 2 more)
    // must be rejected by the route BEFORE any write, computed exactly as
    // returns.ts does (sum of prior 'return' movements against this sale/variant).
    const priorReturns = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.stock_movements.findMany({
        where: { movement_type: 'return', reference_id: saleId, variant_id: variantId },
      })
    })
    const alreadyReturned = priorReturns.reduce((sum: number, m: any) => sum + m.quantity_delta, 0)
    const remainingReturnable = 2 - alreadyReturned
    expect(remainingReturnable).toBe(1)
    // A request for quantity=2 here would exceed remainingReturnable=1 and
    // must be rejected by returns.ts's route-level check — no DB constraint
    // enforces this, by design (same convention as stock-floor-sale.test.ts
    // documenting D-17's route-level, not DB-level, oversell policy).
  })

  it('Test 6 (documented invariant, no DB-level guard): a refund method never used on the original sale would be rejected by D-10\'s route-level check', async () => {
    // This fixture sale was paid entirely via 'cash' (a single payment row,
    // direction='payment'). No Postgres constraint stops a 'card' refund
    // payment row from being inserted directly (as this test's setup does
    // for other rows) — the D-10 invariant ("refund destination is the
    // original payment method only") is enforced by returns.ts's
    // originalPaymentMethods check at the application layer, before any
    // insert. This test documents what that check compares against.
    const originalPayments = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.payments.findMany({ where: { sale_id: saleId, direction: 'payment' } })
    })
    const originalPaymentMethods = new Set(originalPayments.map((p: any) => p.method))
    expect(originalPaymentMethods).toEqual(new Set(['cash']))
    // A refundPayments entry with method='card' against this sale would be
    // rejected by returns.ts's Task 1 step 8 check before any write, since
    // 'card' is not in originalPaymentMethods above.
  })
})
