import { Router } from 'express'
import { forTenant } from '../db/tenantClient'

const router = Router()

/**
 * GET /context exposes only server-owned, display-safe app-shell identity.
 * The tenant scope is always the verified JWT claim; callers cannot select it.
 */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const [tenant, staff] = await Promise.all([
    client.tenants.findFirst({ where: { id: req.user!.tenantId } }),
    client.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } }),
  ])

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' })
  }

  const locality = [tenant.city, tenant.state].filter(Boolean).join(', ') || null
  return res.json({
    staff: { id: staff?.id ?? null, name: staff?.name ?? null, role: req.user!.role },
    tenant: { id: tenant.id, businessName: tenant.business_name, locality },
    onboarding: {
      step: tenant.onboarding_step,
      completed: tenant.onboarding_completed_at !== null,
    },
  })
})

export default router
