import { Prisma } from '@prisma/client'

export interface CheckoutLineInput {
  price: Prisma.Decimal
  quantity: number
  isTaxable: boolean
  lineDiscount?: Prisma.Decimal
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
// ONLY place checkout math happens — routes (03-03) call this rather than
// re-deriving tax/discount logic inline. Partitions taxable vs. exempt line
// subtotals BEFORE applying the tax rate (D-04/D-06, Pitfall 3), applies the
// cart-level discount before tax, and rounds tax exactly once on the
// discounted taxable subtotal using ROUND_HALF_UP (D-03).
export function computeCheckout(input: CheckoutInput): CheckoutResult {
  const ZERO = new Prisma.Decimal(0)
  assertTaxRateFraction(input.taxRate)
  let subtotal = ZERO
  let taxableSubtotal = ZERO

  for (const l of input.lines) {
    const lineTotal = l.price.times(l.quantity).minus(l.lineDiscount ?? ZERO)
    subtotal = subtotal.plus(lineTotal)
    if (l.isTaxable) taxableSubtotal = taxableSubtotal.plus(lineTotal)
  }

  let cartDiscount = ZERO
  if (input.cartDiscountPercent) {
    cartDiscount = subtotal.times(input.cartDiscountPercent.dividedBy(100))
  } else if (input.cartDiscountAmount) {
    cartDiscount = input.cartDiscountAmount
  }

  const taxableShare = subtotal.isZero() ? ZERO : taxableSubtotal.dividedBy(subtotal)
  const discountedTaxableSubtotal = taxableSubtotal.minus(cartDiscount.times(taxableShare))
  const discountedSubtotal = subtotal.minus(cartDiscount)

  const tax = discountedTaxableSubtotal.isNegative()
    ? ZERO
    : discountedTaxableSubtotal.times(input.taxRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const total = discountedSubtotal.plus(tax)

  return { subtotal, cartDiscount, discountedSubtotal, tax, total }
}
