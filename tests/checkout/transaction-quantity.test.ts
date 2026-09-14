import { describe, expect, it } from 'vitest'
import { SaleLineInputSchema } from '../../src/contracts/schemas/sale'
import { ReturnLineInputSchema } from '../../src/contracts/schemas/return'

const variantId = '31111111-1111-4111-8111-111111111111'

describe('sale and return quantity contract', () => {
  it('accepts measured quantities with up to three decimal places', () => {
    expect(SaleLineInputSchema.safeParse({ variantId, quantity: 1.125 }).success).toBe(true)
    expect(ReturnLineInputSchema.safeParse({ saleLineItemId: variantId, quantity: 0.001 }).success).toBe(true)
  })

  it('rejects quantities that PostgreSQL numeric(12,3) would round', () => {
    expect(SaleLineInputSchema.safeParse({ variantId, quantity: 1.1255 }).success).toBe(false)
    expect(ReturnLineInputSchema.safeParse({ saleLineItemId: variantId, quantity: 1.2345 }).success).toBe(false)
  })

  it('rejects quantities outside the persisted numeric range', () => {
    expect(SaleLineInputSchema.safeParse({ variantId, quantity: 1_000_000_000 }).success).toBe(false)
  })
})
