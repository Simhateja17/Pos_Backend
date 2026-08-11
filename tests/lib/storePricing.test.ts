import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { effectivePricesForVariants } from '../../src/lib/storePricing'

describe('store price resolution', () => {
  it('uses a store override when present and the catalog price otherwise', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { variant_id: 'variant-b', price: new Prisma.Decimal('17.50') },
    ])
    const prices = await effectivePricesForVariants(
      { variant_store_prices: { findMany } },
      'store-1',
      [
        { id: 'variant-a', price: new Prisma.Decimal('10.00') },
        { id: 'variant-b', price: new Prisma.Decimal('20.00') },
      ],
    )

    expect(prices.map((price) => price.toFixed(2))).toEqual(['10.00', '17.50'])
    expect(findMany).toHaveBeenCalledWith({
      where: { store_id: 'store-1', variant_id: { in: ['variant-a', 'variant-b'] } },
      select: { variant_id: true, price: true },
    })
  })
})
