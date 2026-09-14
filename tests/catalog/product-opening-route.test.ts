import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const tx = {
  catalog_opening_operations: { findFirst: vi.fn(), create: vi.fn() },
  tenants: { findFirst: vi.fn() }, stores: { findFirst: vi.fn() },
  categories: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  master_items: { findFirst: vi.fn() }, products: { create: vi.fn(), findFirst: vi.fn() },
  variants: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  stock_movements: { create: vi.fn(), findMany: vi.fn() },
  variant_stock_levels: { findMany: vi.fn() },
  staff_members: { findFirst: vi.fn() },
}
const transaction = vi.fn(async (_tenant: string, action: (client: typeof tx) => Promise<unknown>) => action(tx))

vi.mock('../../src/db/tenantClient', () => ({
  forTenantTransaction: transaction,
  forTenant: vi.fn(() => tx),
}))
vi.mock('../../src/lib/stockLevels', () => ({
  stockByVariant: vi.fn(async () => new Map()),
  stockForVariant: vi.fn(async () => 0),
}))

const product = {
  id: '22222222-2222-4222-8222-222222222222', name: 'Bottle', category_id: null,
  master_item_id: null, brand: null, description: null, internal_notes: null, is_active: true,
  created_at: new Date('2026-09-14T00:00:00Z'),
}
const variant = {
  id: '33333333-3333-4333-8333-333333333333', product_id: product.id, sku: 'BOTT-0001', barcode: null,
  unit_of_measure: 'piece', size: null, color: null, material: null, price: '10.00', mrp: null,
  list_price: '12.00', moving_average_cost: null, hsn_sac: null, purchase_unit: null, purchase_pack_size: null,
  track_inventory: true, allow_negative_stock: false, expiry_date: null, is_taxable: true, tax_rate: '0.05',
  reorder_threshold: '4', identity_locked: true, created_at: new Date('2026-09-14T00:00:00Z'),
}
const movement = { id: '44444444-4444-4444-8444-444444444444', variant_id: variant.id, quantity_delta: '12.000' }
const operation = { product_id: product.id, store_id: '55555555-5555-4555-8555-555555555555', request_hash: '' }
const body = {
  clientOperationId: '11111111-1111-4111-8111-111111111111',
  product: { name: 'Bottle', variants: [{ price: 10, listPrice: 12, taxRatePercent: 5, unitOfMeasure: 'piece', trackInventory: true, allowNegativeStock: false }] },
  openingStock: [{ variantIndex: 0, quantityReceived: '12.000' }],
}

async function app() {
  const { default: router } = await import('../../src/routes/products')
  const server = express(); server.use(express.json())
  server.use((req, _res, next) => {
    req.user = { id: 'user-1', tenantId: 'tenant-1', role: 'owner', storeId: operation.store_id }
    req.storeContext = { scope: 'store', activeStoreId: operation.store_id, actingRemotely: false }
    next()
  })
  server.use('/products', router); return server
}

describe('atomic product opening route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tx.catalog_opening_operations.findFirst.mockResolvedValue(null)
    tx.tenants.findFirst.mockResolvedValue({ country: 'US' }); tx.stores.findFirst.mockResolvedValue({ id: operation.store_id })
    tx.categories.findMany.mockResolvedValue([]); tx.products.create.mockResolvedValue(product)
    tx.staff_members.findFirst.mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' })
    tx.variants.create.mockResolvedValue(variant); tx.stock_movements.create.mockResolvedValue(movement)
    tx.catalog_opening_operations.create.mockImplementation(async ({ data }) => ({ ...operation, ...data }))
  })

  it('creates product, variant, receive movement, then immutable operation in one transaction', async () => {
    const response = await request(await app()).post('/products/with-opening-stock').send(body)
    expect(response.status).toBe(201); expect(response.body.replayed).toBe(false)
    expect(transaction).toHaveBeenCalledWith('tenant-1', expect.any(Function))
    expect(tx.stock_movements.create).toHaveBeenCalledWith({ data: expect.objectContaining({ movement_type: 'receive', quantity_delta: '12.000', reference_id: product.id, created_by: '66666666-6666-4666-8666-666666666666' }) })
    expect(tx.catalog_opening_operations.create).toHaveBeenCalledAfter(tx.stock_movements.create)
  })

  it('replays the original result without creating any row', async () => {
    // Capture the route-computed hash from an initial successful request.
    await request(await app()).post('/products/with-opening-stock').send(body)
    const hash = tx.catalog_opening_operations.create.mock.calls[0][0].data.request_hash
    vi.clearAllMocks(); tx.catalog_opening_operations.findFirst.mockResolvedValue({ ...operation, request_hash: hash })
    tx.products.findFirst.mockResolvedValue(product); tx.variants.findMany.mockResolvedValue([variant]); tx.stock_movements.findMany.mockResolvedValue([movement]); tx.categories.findMany.mockResolvedValue([])
    const response = await request(await app()).post('/products/with-opening-stock').send(body)
    expect(response.status).toBe(200); expect(response.body.replayed).toBe(true)
    expect(tx.products.create).not.toHaveBeenCalled(); expect(tx.stock_movements.create).not.toHaveBeenCalled()
  })

  it('rejects reuse of the operation key with different data', async () => {
    tx.catalog_opening_operations.findFirst.mockResolvedValue({ ...operation, request_hash: '0'.repeat(64) })
    const response = await request(await app()).post('/products/with-opening-stock').send(body)
    expect(response.status).toBe(409); expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(tx.products.create).not.toHaveBeenCalled()
  })
})
