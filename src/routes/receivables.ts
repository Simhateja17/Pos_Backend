import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { ReceivablesQuerySchema } from '../contracts/schemas/customerCredit'
import { forTenantTransaction } from '../db/tenantClient'
import { customerSearchWhere } from '../lib/customers'
import { creditLimitString, getCustomerCreditTotals } from '../lib/customerCredit'

const router = Router()

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

type ReceivableRow = {
  customerId: string
  name: string | null
  billingName: string | null
  phone: string | null
  email: string | null
  balance: Prisma.Decimal
  creditLimit: string | null
  recentActivityAt: string | null
}

/**
 * GET / — tenant-wide outstanding balances. Customer identity is shared by all
 * stores, so this intentionally does not apply storeScopeWhere(). Store tags
 * remain available on each ledger entry for future reporting.
 */
router.get('/', async (req, res) => {
  const parsed = ReceivablesQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid receivables query' })

  const result = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    const where: any = {}
    if (parsed.data.search) where.OR = customerSearchWhere(parsed.data.search)

    const customers = await tx.customers.findMany({
      where,
      select: {
        id: true,
        name: true,
        billing_name: true,
        phone: true,
        email: true,
        credit_limit: true,
      },
    })
    const totalsByCustomer = await getCustomerCreditTotals(
      tx,
      customers.map((customer: any) => customer.id),
      req.user!.tenantId,
    )

    const items: ReceivableRow[] = []
    for (const customer of customers as any[]) {
      const totals = totalsByCustomer.get(customer.id)
      const balance = totals?.balance ?? new Prisma.Decimal(0)
      if (!balance.greaterThan(0)) continue
      items.push({
        customerId: customer.id,
        name: customer.name ?? customer.billing_name ?? null,
        billingName: customer.billing_name ?? customer.name ?? null,
        phone: customer.phone ?? null,
        email: customer.email ?? null,
        balance,
        creditLimit: creditLimitString(customer.credit_limit),
        recentActivityAt: iso(totals?.recentActivityAt ?? null),
      })
    }

    items.sort((a, b) => {
      switch (parsed.data.sort) {
        case 'balance_asc':
          return a.balance.comparedTo(b.balance)
        case 'name_asc':
          return (a.billingName ?? a.name ?? '').localeCompare(b.billingName ?? b.name ?? '', 'en', { sensitivity: 'base' })
        case 'recent':
          return (b.recentActivityAt ?? '').localeCompare(a.recentActivityAt ?? '')
        case 'balance_desc':
        default:
          return b.balance.comparedTo(a.balance)
      }
    })

    const outstandingTotal = items.reduce((sum, item) => sum.plus(item.balance), new Prisma.Decimal(0))
    return {
      items: items.slice(0, parsed.data.limit).map((item) => ({
        ...item,
        balance: item.balance.toFixed(2),
      })),
      total: items.length,
      outstandingTotal: outstandingTotal.toFixed(2),
    }
  })

  return res.json(result)
})

export default router
