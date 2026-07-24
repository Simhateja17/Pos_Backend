import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { searchCustomers } from '../lib/customers'

const router = Router()

/**
 * GET /?search= — phone/email/name customer search (CUST-01, D-09). No
 * requireRole gate — customer lookup during checkout/returns is not a
 * sensitive action per CONTEXT.md (only above-threshold discounts and
 * adjustment stock movements are gated).
 */
router.get('/', async (req, res) => {
  const query = (req.query.search as string | undefined) ?? ''
  const client = forTenant(req.user!.tenantId) as any
  const results = await searchCustomers(client, query)
  res.json(results.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, createdAt: c.createdAt.toISOString() })))
})

export default router
