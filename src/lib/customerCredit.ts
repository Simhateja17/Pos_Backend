import { Prisma } from '@prisma/client'
import type { Request } from 'express'

const ZERO = new Prisma.Decimal(0)

export type CreditTotals = {
  creditSales: Prisma.Decimal
  repayments: Prisma.Decimal
  balance: Prisma.Decimal
  recentActivityAt: Date | null
}

export function moneyString(value: Prisma.Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return '0.00'
  // Prisma Decimal values and the lightweight Decimal-shaped objects used by
  // route adapters/tests both expose the same stable string representation.
  return new Prisma.Decimal(value.toString()).toFixed(2)
}

/**
 * Customer credit is an India-only operating capability. Treat a missing
 * tenant row or country as unavailable rather than silently defaulting to
 * India at a financial boundary.
 */
export async function isIndiaTenant(client: any, tenantId: string): Promise<boolean> {
  const tenant = await client.tenants.findFirst({
    where: { id: tenantId },
    select: { country: true },
  })
  return (tenant?.country ?? '').trim().toUpperCase() === 'IN'
}

function emptyTotals(): CreditTotals {
  return {
    creditSales: ZERO,
    repayments: ZERO,
    balance: ZERO,
    recentActivityAt: null,
  }
}

function dateValue(value: unknown): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(String(value))
}

/**
 * Derives balances from immutable ledger rows. There is intentionally no
 * customer balance write anywhere in the application.
 */
export async function getCustomerCreditTotals(
  client: any,
  customerIds: string[],
  tenantId?: string,
): Promise<Map<string, CreditTotals>> {
  const result = new Map<string, CreditTotals>()
  if (customerIds.length === 0) return result

  const rows = await client.customer_credit_transactions.groupBy({
    by: ['customer_id', 'type'],
    where: {
      customer_id: { in: customerIds },
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    _sum: { amount: true },
    _max: { created_at: true },
  })

  for (const row of rows) {
    const current = result.get(row.customer_id) ?? emptyTotals()
    const amount = new Prisma.Decimal(row._sum?.amount ?? 0)
    if (row.type === 'credit_sale') current.creditSales = current.creditSales.plus(amount)
    if (row.type === 'repayment') current.repayments = current.repayments.plus(amount)
    const activity = dateValue(row._max?.created_at)
    if (activity && (!current.recentActivityAt || activity > current.recentActivityAt)) current.recentActivityAt = activity
    current.balance = current.creditSales.minus(current.repayments)
    result.set(row.customer_id, current)
  }

  return result
}

export async function getCustomerCreditTotalsForCustomer(
  client: any,
  tenantId: string,
  customerId: string,
): Promise<CreditTotals> {
  return (await getCustomerCreditTotals(client, [customerId], tenantId)).get(customerId) ?? emptyTotals()
}

/**
 * Serializes the customer row under a row lock. The lock makes two concurrent
 * credit sales for one customer observe a single ordered balance, so a limit
 * cannot be bypassed by racing checkouts. The fallback exists only for small
 * unit-test doubles; production uses the tagged raw query.
 */
export async function lockCustomerForCredit(client: any, customerId: string): Promise<any | null> {
  if (typeof client.$queryRaw === 'function') {
    const rows = await client.$queryRaw`
      select id, credit_limit
      from public.customers
      where id = ${customerId}::uuid
      for update
    `
    return rows[0] ?? null
  }
  return client.customers.findFirst({ where: { id: customerId } })
}

export async function resolveCreditRecorder(client: any, req: Request): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  if (!req.user?.id) return null
  const staff = await client.staff_members.findFirst({
    where: { user_id: req.user.id, is_active: true },
    select: { id: true },
  })
  return staff?.id ?? null
}

export function creditLimitString(value: Prisma.Decimal | string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : moneyString(value)
}
