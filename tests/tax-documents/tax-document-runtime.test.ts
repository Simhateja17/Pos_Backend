import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { ensureTaxInvoice } from '../../src/services/taxDocuments'
import { cleanupSeed, seedTwoTenants, type SeedResult } from '../fixtures/seed'

/**
 * Regression proof for the production GST-invoice 500 seen on 2026-08-15.
 * The runtime role deliberately cannot UPDATE immutable sales, so invoice
 * creation must acquire its serialization lock through the tax-document
 * boundary rather than issuing SELECT ... FOR UPDATE directly as app_runtime.
 */
describe('GST invoice creation through the restricted runtime role', () => {
  let seed: SeedResult
  let runtimeClient: PrismaClient
  let superClient: PrismaClient
  let saleId: string

  beforeAll(async () => {
    seed = await seedTwoTenants()
    runtimeClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL }),
    })
    superClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    })

    const product = await superClient.products.create({
      data: {
        tenant_id: seed.tenantA.id,
        name: `Tax document runtime product ${randomUUID().slice(0, 8)}`,
      },
    })
    const variant = await superClient.variants.create({
      data: {
        tenant_id: seed.tenantA.id,
        product_id: product.id,
        sku: `TAX-${randomUUID().slice(0, 8)}`,
        price: 100,
      },
    })
    const sale = await superClient.sales.create({
      data: {
        tenant_id: seed.tenantA.id,
        store_id: seed.tenantA.storeId,
        client_sale_id: randomUUID(),
        subtotal: 100,
        discount_amount: 0,
        tax_amount: 0,
        total_amount: 100,
        created_by: seed.tenantA.cashier.id,
      },
    })
    saleId = sale.id
    await superClient.sale_line_items.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: sale.id,
        variant_id: variant.id,
        quantity: 1,
        unit_price: 100,
        discount_amount: 0,
        is_taxable: true,
        line_total: 100,
      },
    })
    await superClient.payments.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: sale.id,
        method: 'cash',
        direction: 'payment',
        amount: 100,
        created_by: seed.tenantA.cashier.id,
      },
    })
  }, 90000)

  afterAll(async () => {
    await runtimeClient?.$disconnect()
    await superClient?.$disconnect()
    if (seed) await cleanupSeed(seed)
  }, 90000)

  it('creates and re-reads one invoice without granting UPDATE on sales', async () => {
    const first = await runtimeClient.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      const privileges = await tx.$queryRaw<Array<{ can_update_sales: boolean }>>`
        SELECT has_table_privilege(current_user, 'public.sales', 'UPDATE') AS can_update_sales
      `
      const document = await ensureTaxInvoice(tx, {
        tenantId: seed.tenantA.id,
        saleId,
        createdBy: seed.tenantA.cashier.id,
      })
      return { document, canUpdateSales: privileges[0]?.can_update_sales }
    })

    expect(first.canUpdateSales).toBe(false)
    expect(first.document).not.toBeNull()
    expect(first.document?.saleId).toBe(saleId)
    expect(first.document?.documentType).toBe('tax_invoice')
    expect(first.document?.grandTotal.toString()).toBe('100')

    const second = await runtimeClient.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${seed.tenantA.id}, true)`
      return ensureTaxInvoice(tx, {
        tenantId: seed.tenantA.id,
        saleId,
        createdBy: seed.tenantA.cashier.id,
      })
    })
    expect(second?.id).toBe(first.document?.id)
  })
})
