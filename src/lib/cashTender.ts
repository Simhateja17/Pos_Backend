import { Prisma } from '@prisma/client'

const ZERO = new Prisma.Decimal(0)

export type CashTenderResult =
  | { ok: true; cashPayment: Prisma.Decimal; cashReceived: Prisma.Decimal; changeDue: Prisma.Decimal }
  | { ok: false; error: string }

/**
 * Keeps money allocated to a bill separate from the notes/coins handed over.
 * The caller still validates that every payment allocation sums to the sale
 * total; this function owns only the cash/change invariant.
 */
export function calculateCashChange(
  payments: Array<{ method: string; amount: string }>,
  receivedValue?: string,
): CashTenderResult {
  const cashPayment = payments
    .filter((payment) => payment.method === 'cash')
    .reduce((sum, payment) => sum.plus(new Prisma.Decimal(payment.amount)), ZERO)

  if (cashPayment.isZero() && receivedValue) {
    return { ok: false, error: 'Cash received is only valid when the sale includes a cash payment.' }
  }

  // An omitted physical amount means the customer paid the exact cash
  // allocation. Cashiers only need to enter a value when change is due.
  const cashReceived = receivedValue ? new Prisma.Decimal(receivedValue) : cashPayment
  if (cashReceived.lessThan(cashPayment)) {
    return { ok: false, error: `Cash received must be at least ${cashPayment.toFixed(2)}.` }
  }

  return { ok: true, cashPayment, cashReceived, changeDue: cashReceived.minus(cashPayment) }
}
