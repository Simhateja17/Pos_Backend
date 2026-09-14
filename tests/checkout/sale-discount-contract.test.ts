import { describe, expect, it } from 'vitest'
import { CreateSaleSchema } from '../../src/contracts/schemas/sale'

const base = {
  clientSaleId: '11111111-1111-4111-8111-111111111111',
  shiftId: '21111111-1111-4111-8111-111111111111',
  lines: [{ variantId: '31111111-1111-4111-8111-111111111111', quantity: 1 }],
  payments: [{ method: 'cash', amount: '0.00' }],
}

describe('sale discount request contract', () => {
  it('accepts the exact 100 percent discount boundary', () => {
    expect(CreateSaleSchema.safeParse({ ...base, cartDiscountPercent: '100.00' }).success).toBe(true)
  })

  it('rejects a percentage above 100', () => {
    expect(CreateSaleSchema.safeParse({ ...base, cartDiscountPercent: '100.01' }).success).toBe(false)
  })

  it('accepts at most two distinct tender methods', () => {
    expect(CreateSaleSchema.safeParse({
      ...base,
      payments: [
        { method: 'cash', amount: '5.00' },
        { method: 'card', amount: '5.00', referenceCode: 'terminal-1' },
      ],
    }).success).toBe(true)

    expect(CreateSaleSchema.safeParse({
      ...base,
      payments: [
        { method: 'cash', amount: '5.00' },
        { method: 'cash', amount: '5.00' },
      ],
    }).success).toBe(false)

    expect(CreateSaleSchema.safeParse({
      ...base,
      payments: [
        { method: 'cash', amount: '4.00' },
        { method: 'card', amount: '3.00', referenceCode: 'terminal-1' },
        { method: 'upi', amount: '3.00', referenceCode: 'upi-1' },
      ],
    }).success).toBe(false)
  })
})
