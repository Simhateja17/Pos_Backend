import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { effectiveLinePercent, isApprovedForDiscount } from '../../src/routes/sales'
import { SaleLineInputSchema } from '../../src/contracts/schemas/sale'

describe('discount approval threshold', () => {
  it('converts a rupee line discount to its effective percentage', () => {
    const percent = effectiveLinePercent(
      { discountAmount: '100.00' },
      new Prisma.Decimal('499.00'),
      1,
    )
    expect(percent.toDecimalPlaces(2).toString()).toBe('20.04')
    expect(percent.greaterThan(15)).toBe(true)
  })

  it('accepts the exact 100 percent boundary but refuses values above it', () => {
    const base = { variantId: '11111111-1111-4111-8111-111111111111', quantity: 1 }
    expect(SaleLineInputSchema.safeParse({ ...base, discountPercent: '100.00' }).success).toBe(true)
    expect(SaleLineInputSchema.safeParse({ ...base, discountPercent: '100.01' }).success).toBe(false)
  })

  it('requires escalation for a cashier but treats manager and owner as approvers', () => {
    expect(isApprovedForDiscount({ user: { role: 'cashier' } } as any)).toBe(false)
    expect(isApprovedForDiscount({ user: { role: 'manager' } } as any)).toBe(true)
    expect(isApprovedForDiscount({ user: { role: 'owner' } } as any)).toBe(true)
  })

  it('prefers the active PIN operator over the account owner role', () => {
    expect(isApprovedForDiscount({
      user: { role: 'owner' },
      actingStaff: { role: 'cashier' },
    } as any)).toBe(false)
  })
})
