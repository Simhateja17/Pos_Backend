import { Prisma } from '@prisma/client'

export interface CheckoutLineInput {
  price: Prisma.Decimal
  quantity: number
  isTaxable: boolean
  lineDiscount?: Prisma.Decimal
  /** Optional item rate. The checkout-wide rate remains the legacy fallback. */
  taxRate?: Prisma.Decimal
}

export interface CheckoutInput {
  lines: CheckoutLineInput[]
  cartDiscountPercent?: Prisma.Decimal
  cartDiscountAmount?: Prisma.Decimal
  taxRate: Prisma.Decimal // combined state+county+city+district rate, e.g. 0.0825
}

export interface CheckoutResult {
  subtotal: Prisma.Decimal
  cartDiscount: Prisma.Decimal
  discountedSubtotal: Prisma.Decimal
  tax: Prisma.Decimal
  total: Prisma.Decimal
}

/**
 * Tax rates in the database are decimal fractions: 0.18 means 18%.
 *
 * Keep this invariant at the money boundary as a last line of defence. A
 * percentage-shaped value such as 18 would otherwise turn a ₹2,499 sale into
 * ₹47,481 while still looking like valid Decimal arithmetic.
 */
export class InvalidTaxRateError extends Error {
  readonly code = 'invalid_tax_rate'

  constructor() {
    super('Tax rate must be a decimal fraction between 0 and 1')
    this.name = 'InvalidTaxRateError'
  }
}

function assertTaxRateFraction(taxRate: Prisma.Decimal): void {
  if (taxRate.isNegative() || taxRate.greaterThan(1)) {
    throw new InvalidTaxRateError()
  }
}

// Server-authoritative Decimal-based tax/discount computation. This is the
// ONLY place checkout math happens — routes call this rather than re-deriving
// tax/discount logic inline. The cart discount is allocated across line bases,
// then every taxable line is taxed at its own item rate. The checkout-wide
// rate is retained only as the compatibility fallback for legacy variants.
export function computeCheckout(input: CheckoutInput): CheckoutResult {
  const ZERO = new Prisma.Decimal(0)
  const lineBases = input.lines.map((line) => line.price.times(line.quantity).minus(line.lineDiscount ?? ZERO))
  const subtotal = lineBases.reduce((sum, value) => sum.plus(value), ZERO)

  let cartDiscount = ZERO
  if (input.cartDiscountPercent) {
    cartDiscount = subtotal.times(input.cartDiscountPercent.dividedBy(100))
  } else if (input.cartDiscountAmount) {
    cartDiscount = input.cartDiscountAmount
  }

  const discountedSubtotal = subtotal.minus(cartDiscount)
  const discountedLineBases = lineBases.map((lineBase) =>
    subtotal.isZero() ? lineBase : lineBase.minus(cartDiscount.times(lineBase).dividedBy(subtotal)),
  )

  const rawTax = input.lines.reduce((sum, line, index) => {
    if (!line.isTaxable) return sum
    const taxRate = line.taxRate ?? input.taxRate
    assertTaxRateFraction(taxRate)
    return sum.plus(discountedLineBases[index].times(taxRate))
  }, ZERO)

  const tax = rawTax.isNegative()
    ? ZERO
    : rawTax.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const total = discountedSubtotal.plus(tax)

  return { subtotal, cartDiscount, discountedSubtotal, tax, total }
}
