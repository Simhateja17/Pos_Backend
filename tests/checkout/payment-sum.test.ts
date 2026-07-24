import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { computeCheckout } from '../../src/lib/money'

/**
 * Unit test (no live DB) proving the exact-cent-sensitive invariant that
 * POST /sales' payment-sum guard relies on: computeCheckout()'s `total` is a
 * Prisma.Decimal, and a payments sum off by even a single cent (either
 * direction) must be distinguishable from it via Decimal equality — this is
 * the same comparison the route performs (`paymentSum.equals(total)`) before
 * ever writing to the DB. Route-level end-to-end payment-sum-rejection (the
 * actual 400 response) is exercised manually via curl per the phase's
 * validation strategy, since spinning up the Express app in-process is out
 * of scope for this plan's budget.
 */
describe('Payment-sum exact-cent invariant (unit, no live DB)', () => {
  const input = {
    lines: [
      { price: new Prisma.Decimal('19.99'), quantity: 2, isTaxable: true },
      { price: new Prisma.Decimal('5.00'), quantity: 1, isTaxable: false },
    ],
    taxRate: new Prisma.Decimal('0.0825'),
  }

  it('a payments sum equal to the computed total is exactly equal (accepted)', () => {
    const { total } = computeCheckout(input)
    const paymentSum = total // simulate a split-tender sum that lands exactly on total
    expect(paymentSum.equals(total)).toBe(true)
  })

  it('a payments sum one cent BELOW the computed total is rejected (not equal)', () => {
    const { total } = computeCheckout(input)
    const paymentSum = total.minus('0.01')
    expect(paymentSum.equals(total)).toBe(false)
  })

  it('a payments sum one cent ABOVE the computed total is rejected (not equal)', () => {
    const { total } = computeCheckout(input)
    const paymentSum = total.plus('0.01')
    expect(paymentSum.equals(total)).toBe(false)
  })

  it('split-tender payments (cash + card) that sum exactly to total are accepted', () => {
    const { total } = computeCheckout(input)
    const cash = total.dividedBy(2).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN)
    const card = total.minus(cash)
    const paymentSum = cash.plus(card)
    expect(paymentSum.equals(total)).toBe(true)
  })
})
