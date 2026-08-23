import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { computeCheckout } from '../../src/lib/money'

const D = (v: string) => new Prisma.Decimal(v)

describe('computeCheckout', () => {
  it('Test 1: no discount, all taxable — subtotal/tax/total computed correctly', () => {
    const result = computeCheckout({
      lines: [
        { price: D('10.00'), quantity: 2, isTaxable: true },
        { price: D('5.00'), quantity: 1, isTaxable: true },
      ],
      taxRate: D('0.0825'),
    })
    expect(result.subtotal.toString()).toBe('25')
    expect(result.tax.toString()).toBe('2.06')
    expect(result.total.toString()).toBe('27.06')
  })

  it('Test 2: cart-level discount applied before tax', () => {
    const result = computeCheckout({
      lines: [
        { price: D('10.00'), quantity: 2, isTaxable: true },
        { price: D('5.00'), quantity: 1, isTaxable: true },
      ],
      cartDiscountPercent: D('10'),
      taxRate: D('0.0825'),
    })
    expect(result.discountedSubtotal.toString()).toBe('22.5')
    expect(result.tax.toString()).toBe('1.86')
    expect(result.total.toString()).toBe('24.36')
  })

  it('Test 3: cart discount allocated proportionally across taxable/exempt shares', () => {
    const result = computeCheckout({
      lines: [
        { price: D('20.00'), quantity: 1, isTaxable: true },
        { price: D('20.00'), quantity: 1, isTaxable: false },
      ],
      cartDiscountAmount: D('10.00'),
      taxRate: D('0.0825'),
    })
    expect(result.tax.toString()).toBe('1.24')
  })

  it('Test 4: sum(line totals after discount) + tax always equals total to the exact cent', () => {
    const cases = [
      { discountPercent: '0', taxRate: '0.0825' },
      { discountPercent: '5', taxRate: '0.06' },
      { discountPercent: '15', taxRate: '0.0925' },
      { discountPercent: '25', taxRate: '0.07' },
      { discountPercent: '50', taxRate: '0.0825' },
    ]
    for (const c of cases) {
      const result = computeCheckout({
        lines: [
          { price: D('13.37'), quantity: 3, isTaxable: true },
          { price: D('7.49'), quantity: 2, isTaxable: false },
        ],
        cartDiscountPercent: D(c.discountPercent),
        taxRate: D(c.taxRate),
      })
      expect(result.discountedSubtotal.plus(result.tax).toString()).toBe(result.total.toString())
    }
  })

  it('Test 5: line-level discount and cart-level discount both reduce the same line without double-counting', () => {
    const result = computeCheckout({
      lines: [{ price: D('50.00'), quantity: 1, isTaxable: true, lineDiscount: D('5.00') }],
      cartDiscountAmount: D('10.00'),
      taxRate: D('0.0825'),
    })
    // subtotal after line discount = 45.00; cart discount further reduces to 35.00
    expect(result.subtotal.toString()).toBe('45')
    expect(result.discountedSubtotal.toString()).toBe('35')
    expect(result.tax.toString()).toBe('2.89')
    expect(result.total.toString()).toBe('37.89')
  })

  it('Test 6: an 18% rate is represented as 0.18 and produces the correct total', () => {
    const result = computeCheckout({
      lines: [{ price: D('2499.00'), quantity: 1, isTaxable: true }],
      taxRate: D('0.18'),
    })

    expect(result.tax.toString()).toBe('449.82')
    expect(result.total.toString()).toBe('2948.82')
  })

  it('Test 7: rejects a percentage-shaped rate before it can inflate a sale total', () => {
    expect(() =>
      computeCheckout({
        lines: [{ price: D('2499.00'), quantity: 1, isTaxable: true }],
        taxRate: D('18'),
      }),
    ).toThrow(/decimal fraction between 0 and 1/i)
  })

  it('uses each taxable item rate instead of one cart-wide rate', () => {
    const result = computeCheckout({
      lines: [
        { price: D('100.00'), quantity: 1, isTaxable: true, taxRate: D('0.05') },
        { price: D('100.00'), quantity: 1, isTaxable: true, taxRate: D('0.18') },
      ],
      taxRate: D('0.18'),
    })

    expect(result.tax.toString()).toBe('23')
    expect(result.total.toString()).toBe('223')
  })

  it('allocates a cart discount before applying mixed item rates', () => {
    const result = computeCheckout({
      lines: [
        { price: D('100.00'), quantity: 1, isTaxable: true, taxRate: D('0.05') },
        { price: D('100.00'), quantity: 1, isTaxable: true, taxRate: D('0.18') },
      ],
      cartDiscountAmount: D('10.00'),
      taxRate: D('0.18'),
    })

    expect(result.tax.toString()).toBe('21.85')
    expect(result.total.toString()).toBe('211.85')
  })

  it('does not require the legacy store fallback when every taxable item has a rate', () => {
    const result = computeCheckout({
      lines: [{ price: D('100.00'), quantity: 1, isTaxable: true, taxRate: D('0.05') }],
      taxRate: D('18'),
    })

    expect(result.tax.toString()).toBe('5')
  })

  it('rejects a line discount greater than the line value', () => {
    expect(() =>
      computeCheckout({
        lines: [{ price: D('499.00'), quantity: 1, isTaxable: true, lineDiscount: D('600.00') }],
        taxRate: D('0.18'),
      }),
    ).toThrow(/discount cannot exceed the line value/i)
  })

  it('rejects a negative line discount instead of treating it as a surcharge', () => {
    expect(() =>
      computeCheckout({
        lines: [{ price: D('499.00'), quantity: 1, isTaxable: true, lineDiscount: D('-50.00') }],
        taxRate: D('0.18'),
      }),
    ).toThrow(/discount cannot be negative/i)
  })

  it('rejects a whole-cart discount greater than the discounted cart subtotal', () => {
    expect(() =>
      computeCheckout({
        lines: [{ price: D('499.00'), quantity: 1, isTaxable: true }],
        cartDiscountAmount: D('9999.00'),
        taxRate: D('0.18'),
      }),
    ).toThrow(/discount cannot exceed the cart subtotal/i)
  })
})
