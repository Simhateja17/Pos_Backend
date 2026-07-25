import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { searchCustomers } from '../lib/customers'
import { CustomerListQuerySchema } from '../contracts/schemas/customer'

const router = Router()

/**
 * GET /?search= — phone/email/name customer search (CUST-01, D-09). No
 * requireRole gate — customer lookup during checkout/returns is not a
 * sensitive action per CONTEXT.md (only above-threshold discounts and
 * adjustment stock movements are gated).
 */
router.get('/records', async (req, res) => {
  const parsed = CustomerListQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid customer query' })

  const client = forTenant(req.user!.tenantId) as any
  const where: any = {}
  if (parsed.data.search) {
    where.OR = [
      { phone: { contains: parsed.data.search } },
      { email: { contains: parsed.data.search, mode: 'insensitive' } },
      { name: { contains: parsed.data.search, mode: 'insensitive' } },
    ]
  }
  if (parsed.data.cursor) where.created_at = { lt: new Date(parsed.data.cursor) }

  const [rows, total] = await Promise.all([
    client.customers.findMany({ where, orderBy: { created_at: 'desc' }, take: parsed.data.limit + 1 }),
    client.customers.count({ where }),
  ])
  const hasMore = rows.length > parsed.data.limit
  const items = rows.slice(0, parsed.data.limit).map((c: any) => ({
    id: c.id, name: c.name, phone: c.phone, email: c.email, createdAt: c.created_at.toISOString(),
  }))
  return res.json({
    items,
    total,
    nextCursor: hasMore ? items[items.length - 1].createdAt : null,
  })
})

// Checkout retains its existing compact search array contract. Record pages
// use /records above so changing their pagination envelope cannot break a live
// checkout consumer.
router.get('/', async (req, res) => {
  const query = (req.query.search as string | undefined) ?? ''
  const client = forTenant(req.user!.tenantId) as any
  const results = await searchCustomers(client, query)
  return res.json(results.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, createdAt: c.createdAt.toISOString() })))
})

export default router
