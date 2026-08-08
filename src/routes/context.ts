import { Router } from 'express'
import { forTenantTransaction } from '../db/tenantClient'

const router = Router()

/**
 * GET /context exposes only server-owned, display-safe app-shell identity.
 * The tenant scope is always the verified JWT claim; callers cannot select it.
 */
router.get('/', async (req, res) => {
  // The acting identity wins over the terminal's own session, mirroring
  // requireRole's precedence. On a shared till a cashier PIN-switches into an
  // owner's logged-in session; the shell — and anything keyed off it, such as
  // "which shift is mine" — must then read as that cashier, not the owner.
  const actingStaffId = req.actingStaff?.id ?? null

  const { tenant, staff } = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    // These are intentionally sequential on one transaction client. Promise
    // parallelism against a single pg client does not reduce database work,
    // and using two independent tenant transactions was the direct source of
    // the observed P2028 burst in this route.
    const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
    const staff = actingStaffId
      ? await tx.staff_members.findFirst({ where: { id: actingStaffId, is_active: true } })
      : await tx.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } })
    return { tenant, staff }
  })

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' })
  }

  const locality = [tenant.city, tenant.state].filter(Boolean).join(', ') || null
  return res.json({
    staff: {
      id: staff?.id ?? null,
      name: staff?.name ?? null,
      role: req.actingStaff?.role ?? req.user!.role,
    },
    tenant: { id: tenant.id, businessName: tenant.business_name, locality },
    onboarding: {
      step: tenant.onboarding_step,
      completed: tenant.onboarding_completed_at !== null,
    },
  })
})

export default router
