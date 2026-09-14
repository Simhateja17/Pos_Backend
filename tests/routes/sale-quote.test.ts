import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), store: vi.fn(), variant: vi.fn(), stock: vi.fn(), prices: vi.fn(), transaction: vi.fn(), scope: vi.fn() }))
vi.mock('../../src/db/tenantClient', () => ({ forTenantTransaction: mocks.transaction }))
vi.mock('../../src/lib/storePricing', () => ({ effectivePricesForVariants: mocks.prices }))
vi.mock('../../src/middleware/storeContext', () => ({ activeStoreId: mocks.scope }))
import quoteRouter from '../../src/routes/saleQuote'
import { SaleQuoteSchema } from '../../src/contracts/schemas/sale'

const variantId = '22222222-2222-4222-8222-222222222222'
const storeId = '66666666-6666-4666-8666-666666666666'
const client = { tenants: { findFirst: mocks.tenant }, stores: { findFirst: mocks.store }, variants: { findFirst: mocks.variant }, variant_stock_levels: { findFirst: mocks.stock } }
const app = express().use(express.json()).use((req, _res, next) => { req.user = { tenantId: 'tenant-a' } as any; next() }).use('/sales', quoteRouter)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope.mockReturnValue(storeId)
  mocks.transaction.mockImplementation(async (_tenant, action) => action(client))
  mocks.tenant.mockResolvedValue({ country: 'IN' })
  mocks.store.mockResolvedValue({ tax_rate_state: '0.18', tax_rate_county: 0, tax_rate_city: 0, tax_rate_district: 0 })
  mocks.variant.mockResolvedValue({ id: variantId, unit_of_measure: 'piece', products: { name: 'Test product', is_active: true }, track_inventory: true, allow_negative_stock: false, is_taxable: true, tax_rate: null })
  mocks.stock.mockResolvedValue({ quantity: 5 })
  mocks.prices.mockResolvedValue([new Prisma.Decimal('0.10')])
})

describe('mobile sale quote', () => {
  it('uses store pricing, Decimal tax and the tenant transaction boundary', async () => {
    const response = await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 3 }] })
    expect(response.status).toBe(200)
    expect(SaleQuoteSchema.parse(response.body)).toMatchObject({ storeId, currency: 'INR', subtotal: '0.30', discountAmount: '0.00', taxAmount: '0.05', totalAmount: '0.35' })
    expect(mocks.transaction).toHaveBeenCalledWith('tenant-a', expect.any(Function))
    expect(mocks.prices).toHaveBeenCalledWith(client, storeId, expect.any(Array))
    expect(mocks.stock).toHaveBeenCalledWith({ where: { variant_id: variantId, store_id: storeId } })
  })
  it('aggregates repeated lines before checking the stock floor', async () => {
    const response = await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 3 }, { variantId, quantity: 3 }] })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('INSUFFICIENT_STOCK')
  })
  it('rejects an inactive product', async () => {
    mocks.variant.mockResolvedValue({ products: { is_active: false } })
    expect((await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 1 }] })).status).toBe(409)
  })
  it('does not accept client prices and rejects fractions for discrete units', async () => {
    expect((await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 1, price: 0 }] })).status).toBe(400)
    expect((await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 1.5 }] })).status).toBe(400)
    // The unknown client price is rejected at the schema boundary. Fractional
    // validity depends on the server-owned unit, so only that request enters
    // the tenant transaction.
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })
  it('accepts fractional quantities only for measured units', async () => {
    mocks.variant.mockResolvedValue({ id: variantId, unit_of_measure: 'kg', products: { name: 'Rice', is_active: true }, track_inventory: true, allow_negative_stock: false, is_taxable: true, tax_rate: null })
    mocks.prices.mockResolvedValue([new Prisma.Decimal('10.00')])
    const response = await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 1.5 }] })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ subtotal: '15.00', discountAmount: '0.00', taxAmount: '2.70', totalAmount: '17.70' })
  })
  it('uses the same Decimal discount contract as final checkout', async () => {
    mocks.prices.mockResolvedValue([new Prisma.Decimal('100.00')])
    const response = await request(app).post('/sales/quote').send({
      lines: [{ variantId, quantity: 1, discountPercent: '10.00' }],
      cartDiscountAmount: '5.00',
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ subtotal: '90.00', discountAmount: '5.00', taxAmount: '15.30', totalAmount: '100.30' })
  })
  it('requires an explicit store', async () => {
    mocks.scope.mockImplementation(() => { throw new Error('business scope') })
    expect((await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 1 }] })).status).toBe(400)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('never exposes another tenant variant and never writes stock', async () => {
    mocks.variant.mockResolvedValue(null)
    expect((await request(app).post('/sales/quote').send({ lines: [{ variantId, quantity: 1 }] })).status).toBe(404)
    expect(mocks.stock).not.toHaveBeenCalled()
  })
})
