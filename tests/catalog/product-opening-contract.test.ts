import { describe, expect, it } from 'vitest'
import { CreateProductWithOpeningStockSchema } from '../../src/contracts/schemas/product'

const operationId = '11111111-1111-4111-8111-111111111111'
const tracked = { price: 10, mrp: 12, taxRatePercent: 5, unitOfMeasure: 'piece', trackInventory: true, allowNegativeStock: false }

describe('atomic product opening-stock contract', () => {
  it('accepts one positive opening quantity for each tracked variant', () => {
    const result = CreateProductWithOpeningStockSchema.safeParse({
      clientOperationId: operationId,
      product: { name: 'Bottle', variants: [tracked] },
      openingStock: [{ variantIndex: 0, quantityReceived: '12' }],
    })
    expect(result.success).toBe(true)
  })

  it.each([
    ['missing tracked opening', { product: { name: 'Bottle', variants: [tracked] }, openingStock: [] }],
    ['duplicate index', { product: { name: 'Bottle', variants: [tracked] }, openingStock: [{ variantIndex: 0, quantityReceived: '1' }, { variantIndex: 0, quantityReceived: '2' }] }],
    ['untracked opening', { product: { name: 'Service', variants: [{ ...tracked, trackInventory: false }] }, openingStock: [{ variantIndex: 0, quantityReceived: '1' }] }],
    ['negative-stock policy', { product: { name: 'Bottle', variants: [{ ...tracked, allowNegativeStock: true }] }, openingStock: [{ variantIndex: 0, quantityReceived: '1' }] }],
    ['unknown index', { product: { name: 'Bottle', variants: [tracked] }, openingStock: [{ variantIndex: 1, quantityReceived: '1' }] }],
    ['fractional piece', { product: { name: 'Bottle', variants: [tracked] }, openingStock: [{ variantIndex: 0, quantityReceived: '1.5' }] }],
  ])('rejects %s', (_label, body) => {
    expect(CreateProductWithOpeningStockSchema.safeParse({ clientOperationId: operationId, ...body }).success).toBe(false)
  })

  it('allows a fractional opening quantity for a fractional unit', () => {
    const result = CreateProductWithOpeningStockSchema.safeParse({
      clientOperationId: operationId,
      product: { name: 'Rice', variants: [{ ...tracked, unitOfMeasure: 'kg' }] },
      openingStock: [{ variantIndex: 0, quantityReceived: '2.750' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects omitted inventory flags instead of inheriting catalog defaults', () => {
    const { trackInventory: _track, allowNegativeStock: _negative, ...withoutFlags } = tracked
    expect(CreateProductWithOpeningStockSchema.safeParse({
      clientOperationId: operationId,
      product: { name: 'Bottle', variants: [withoutFlags] },
      openingStock: [{ variantIndex: 0, quantityReceived: '1' }],
    }).success).toBe(false)
  })
})
