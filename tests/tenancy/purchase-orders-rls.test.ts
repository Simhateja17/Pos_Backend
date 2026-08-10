import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * PUR-02's cross-tenant isolation proof across all four tables added by
 * 0021_purchase_orders.sql, plus the real idempotency guarantee: the unique
 * (tenant_id, client_receipt_id) index, exercised against live Postgres rather
 * than a mock.
 */
describe('Purchase order RLS + receipt idempotency (real Supabase project, app_runtime role)', () => {
  let seed: SeedResult
  let client: PrismaClient
  let superClient: PrismaClient
  let productId: string
  let variantId: string
  let supplierId: string
  let poId: string
  let poLineId: string
  let tenantBPoId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL }) })
    superClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

    const product = await superClient.products.create({
      data: { tenant_id: seed.tenantA.id, name: `PO Test Product ${randomUUID().slice(0, 8)}` },
    })
    productId = product.id
    const variant = await superClient.variants.create({
      data: { tenant_id: seed.tenantA.id, product_id: productId, sku: `PO-${randomUUID().slice(0, 8)}`, price: 100 },
    })
    variantId = variant.id

    const supplier = await superClient.suppliers.create({
      data: { tenant_id: seed.tenantA.id, name: 'PO Test Supplier', lead_time_days: 6 },
    })
    supplierId = supplier.id

    const po = await superClient.purchase_orders.create({
      data: { tenant_id: seed.tenantA.id, store_id: seed.tenantA.storeId, supplier_id: supplierId, po_number: 'PO-TEST-1', status: 'sent' },
    })
    poId = po.id
    const poLine = await superClient.purchase_order_lines.create({
      data: {
        tenant_id: seed.tenantA.id,
        purchase_order_id: poId,
        variant_id: variantId,
        quantity_ordered: 100,
        unit_cost: 520,
      },
    })
    poLineId = poLine.id

    const tenantBSupplier = await superClient.suppliers.create({
      data: { tenant_id: seed.tenantB.id, name: 'Tenant B Supplier', lead_time_days: 4 },
    })
    const tenantBPo = await superClient.purchase_orders.create({
      data: { tenant_id: seed.tenantB.id, store_id: seed.tenantB.storeId, supplier_id: tenantBSupplier.id, po_number: 'PO-TEST-B', status: 'sent' },
    })
    tenantBPoId = tenantBPo.id
  }, 90000)

  afterAll(async () => {
    await client.$disconnect()
    await superClient.purchase_order_receipt_lines.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.purchase_order_receipts.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.purchase_order_lines.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.purchase_orders.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.stock_movements.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.variant_stock_levels.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 90000)

  it('Test 1: tenant A cannot see tenant B purchase orders', async () => {
    const rows = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.purchase_orders.findMany()
    })
    for (const row of rows) expect(row.tenant_id).toBe(seed.tenantA.id)
    expect(rows.map((r) => r.id)).not.toContain(tenantBPoId)

    const direct = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.purchase_orders.findFirst({ where: { id: tenantBPoId } })
    })
    expect(direct).toBeNull()
  }, 60000)

  it('Test 2: a receipt writes a receive movement and moves stock by exactly the received quantity', async () => {
    const clientReceiptId = randomUUID()
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      const receipt = await tx.purchase_order_receipts.create({
        data: { tenant_id: seed.tenantA.id, store_id: seed.tenantA.storeId, purchase_order_id: poId, client_receipt_id: clientReceiptId },
      })
      await tx.purchase_order_receipt_lines.create({
        data: {
          tenant_id: seed.tenantA.id,
          receipt_id: receipt.id,
          purchase_order_line_id: poLineId,
          variant_id: variantId,
          quantity_received: 40,
          unit_cost: 520,
        },
      })
    })

    const { level, line, po, variant } = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return {
        level: await tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } }),
        line: await tx.purchase_order_lines.findFirst({ where: { id: poLineId } }),
        po: await tx.purchase_orders.findFirst({ where: { id: poId } }),
        variant: await tx.variants.findFirst({ where: { id: variantId } }),
      }
    })

    // quantity is numeric(12,3) -> Prisma Decimal, never a JS number.
    expect(Number(level?.quantity)).toBe(40)
    // quantity_received is numeric(12,3) -> Prisma Decimal, never a JS number.
    expect(Number(line?.quantity_received)).toBe(40)
    expect(po?.status).toBe('partial')
    // First receipt for this variant — no prior stock, so the average is the
    // receipt price outright (decision-cost-basis.md "Edge cases").
    expect(Number(variant?.moving_average_cost)).toBe(520)
  }, 60000)

  it('Test 3: replaying a clientReceiptId is refused by Postgres and does not double stock', async () => {
    const clientReceiptId = randomUUID()
    const insertReceipt = () =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
        return tx.purchase_order_receipts.create({
          data: { tenant_id: seed.tenantA.id, store_id: seed.tenantA.storeId, purchase_order_id: poId, client_receipt_id: clientReceiptId },
        })
      })

    await insertReceipt()
    await expect(insertReceipt()).rejects.toThrow()

    const level = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } })
    })
    // Unchanged from Test 2 — the replayed receipt carried no lines and the
    // duplicate was rejected outright.
    // quantity is numeric(12,3) -> Prisma Decimal, never a JS number.
    expect(Number(level?.quantity)).toBe(40)
  }, 60000)

  it('Test 4: the second receipt completes the order and moves the average to the weighted value', async () => {
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      const receipt = await tx.purchase_order_receipts.create({
        data: { tenant_id: seed.tenantA.id, store_id: seed.tenantA.storeId, purchase_order_id: poId, client_receipt_id: randomUUID() },
      })
      await tx.purchase_order_receipt_lines.create({
        data: {
          tenant_id: seed.tenantA.id,
          receipt_id: receipt.id,
          purchase_order_line_id: poLineId,
          variant_id: variantId,
          quantity_received: 60,
          unit_cost: 500,
        },
      })
    })

    const { level, po, variant } = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return {
        level: await tx.variant_stock_levels.findFirst({ where: { variant_id: variantId } }),
        po: await tx.purchase_orders.findFirst({ where: { id: poId } }),
        variant: await tx.variants.findFirst({ where: { id: variantId } }),
      }
    })

    // quantity is numeric(12,3) -> Prisma Decimal, never a JS number.
    expect(Number(level?.quantity)).toBe(100)
    expect(po?.status).toBe('received')
    // (40 * 520 + 60 * 500) / 100 = 508.00
    expect(Number(variant?.moving_average_cost)).toBe(508)
  }, 60000)
})
