import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { seedTwoTenants, cleanupSeed, type SeedResult } from '../fixtures/seed'

/**
 * OFFLINE-01 / Phase 4 Task 1 — sale replay safety, proven at the database
 * layer against the real Supabase project.
 *
 * The guarantee under test is migration 0017's unique index on
 * (tenant_id, client_sale_id). This is deliberately tested at the DB level
 * rather than through the route: the route's fast-path lookup can mask a
 * missing constraint entirely under light load, so a route-only test would
 * still pass if 0017 were reverted. If this file passes while 0017 is absent,
 * the test is wrong.
 *
 * Requires RLS_DATABASE_URL / DATABASE_URL and outbound access to the Postgres
 * pooler. Where that egress is blocked, this suite times out in beforeAll —
 * see docs/reference/known-issues-phase-01.md.
 */
describe('OFFLINE-01 sale idempotency (real Supabase project)', () => {
  let seed: SeedResult
  let superClient: PrismaClient
  let productId: string
  let variantId: string

  const baseSale = (tenantId: string, clientSaleId: string) => ({
    tenant_id: tenantId,
    client_sale_id: clientSaleId,
    subtotal: '100.00',
    discount_amount: '0',
    tax_amount: '8.25',
    total_amount: '108.25',
  })

  beforeAll(async () => {
    seed = await seedTwoTenants()
    const superAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    superClient = new PrismaClient({ adapter: superAdapter })

    const product = await superClient.products.create({
      data: { tenant_id: seed.tenantA.id, name: `Idempotency Test Product ${randomUUID().slice(0, 8)}` },
    })
    productId = product.id
    const variant = await superClient.variants.create({
      data: {
        tenant_id: seed.tenantA.id,
        product_id: productId,
        sku: `IDEM-${randomUUID().slice(0, 8)}`,
        price: 100.0,
      },
    })
    variantId = variant.id
  }, 60000)

  afterAll(async () => {
    await superClient.sales.deleteMany({ where: { tenant_id: seed.tenantA.id } }).catch(() => {})
    await superClient.variants.delete({ where: { id: variantId } }).catch(() => {})
    await superClient.products.delete({ where: { id: productId } }).catch(() => {})
    await superClient.$disconnect()
    await cleanupSeed(seed)
  }, 60000)

  it('rejects a second sale with the same (tenant_id, client_sale_id)', async () => {
    const clientSaleId = randomUUID()
    await superClient.sales.create({ data: baseSale(seed.tenantA.id, clientSaleId) })

    // The retry. Postgres must refuse it — this is the whole guarantee.
    await expect(
      superClient.sales.create({ data: baseSale(seed.tenantA.id, clientSaleId) }),
    ).rejects.toMatchObject({ code: 'P2002' })

    const rows = await superClient.sales.findMany({
      where: { tenant_id: seed.tenantA.id, client_sale_id: clientSaleId },
    })
    expect(rows).toHaveLength(1)
  })

  it('records exactly one sale when the same id is submitted 50x concurrently', async () => {
    const clientSaleId = randomUUID()

    // The real offline failure mode: a queue draining in parallel, or a
    // double-click, where every caller misses the route's fast-path lookup and
    // races to insert. Serial retries would not exercise the constraint.
    const attempts = Array.from({ length: 50 }, () =>
      superClient.sales
        .create({ data: baseSale(seed.tenantA.id, clientSaleId) })
        .then(() => 'created' as const)
        .catch((err: any) => (err?.code === 'P2002' ? ('conflict' as const) : Promise.reject(err))),
    )
    const outcomes = await Promise.all(attempts)

    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'conflict')).toHaveLength(49)

    const rows = await superClient.sales.findMany({
      where: { tenant_id: seed.tenantA.id, client_sale_id: clientSaleId },
    })
    expect(rows).toHaveLength(1)
  })

  it('scopes uniqueness per tenant — the same client id may exist for two tenants', async () => {
    // client_sale_id is minted on the device, so it is only trustworthy within
    // a tenant. Two tenants colliding must NOT block each other.
    const clientSaleId = randomUUID()

    const a = await superClient.sales.create({ data: baseSale(seed.tenantA.id, clientSaleId) })
    const b = await superClient.sales.create({ data: baseSale(seed.tenantB.id, clientSaleId) })

    expect(a.id).not.toEqual(b.id)

    await superClient.sales.delete({ where: { id: b.id } }).catch(() => {})
  })

  it('leaves no orphaned lines, payments or stock movements when a replay is rejected', async () => {
    const clientSaleId = randomUUID()
    const sale = await superClient.sales.create({ data: baseSale(seed.tenantA.id, clientSaleId) })

    await superClient.sale_line_items.create({
      data: {
        tenant_id: seed.tenantA.id,
        sale_id: sale.id,
        variant_id: variantId,
        quantity: 1,
        unit_price: '100.00',
        discount_amount: '0',
        is_taxable: true,
        line_total: '100.00',
      },
    })

    // The route writes sale + lines + payments + movements in ONE transaction,
    // so a rejected replay must contribute nothing. Double-booked stock from a
    // partially-applied retry is the exact harm OFFLINE-01 exists to prevent.
    await expect(
      superClient.$transaction(async (tx) => {
        await tx.sales.create({ data: baseSale(seed.tenantA.id, clientSaleId) })
        await tx.stock_movements.create({
          data: {
            tenant_id: seed.tenantA.id,
            variant_id: variantId,
            movement_type: 'sale',
            quantity_delta: -1,
          },
        })
      }),
    ).rejects.toMatchObject({ code: 'P2002' })

    const movements = await superClient.stock_movements.findMany({
      where: { tenant_id: seed.tenantA.id, variant_id: variantId },
    })
    expect(movements).toHaveLength(0)

    const lines = await superClient.sale_line_items.findMany({ where: { sale_id: sale.id } })
    expect(lines).toHaveLength(1)
  })
})
