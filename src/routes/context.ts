import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { forTenantTransaction } from '../db/tenantClient'
import { statesMatch } from '../services/taxDocuments'
import { errorEnvelope } from '../contracts/schemas/error'

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

  const role = req.actingStaff?.role ?? req.user!.role
  const ownStoreId = req.actingStaff?.storeId ?? req.user!.storeId
  const { tenant, staff, store, stores } = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    // These are intentionally sequential on one transaction client. Promise
    // parallelism against a single pg client does not reduce database work,
    // and using two independent tenant transactions was the direct source of
    // the observed P2028 burst in this route.
    const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
    const staff = actingStaffId
      ? await tx.staff_members.findFirst({ where: { id: actingStaffId, is_active: true } })
      : await tx.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } })
    const store = req.storeContext?.activeStoreId
      ? await tx.stores.findFirst({ where: { id: req.storeContext.activeStoreId } })
      : null
    const stores = await tx.stores.findMany({
      where: role === 'owner' ? {} : { id: ownStoreId },
      orderBy: [{ created_at: 'asc' }],
    })
    return { tenant, staff, store, stores }
  })

  if (!tenant) {
    return res.status(404).json(errorEnvelope('NO_MEMBERSHIP', 'Tenant not found'))
  }

  const locality = [tenant.city, tenant.state].filter(Boolean).join(', ') || null
  const operator = req.accessContext?.operator
  const permissions = role === 'owner'
    ? ['context:read', 'stores:read', 'stores:select', 'members:write', 'reports:read', 'sales:write', 'inventory:write']
    : role === 'manager'
      ? ['context:read', 'stores:read', 'sales:write', 'inventory:write', 'reports:read']
      : ['context:read', 'stores:read', 'sales:write']
  const capabilities = role === 'cashier'
    ? ['sales', 'returns:request', 'shift']
    : ['sales', 'catalogue', 'inventory', 'reports', 'staff']
  const operatorJson = operator?.state === 'valid'
    ? {
        state: 'valid' as const,
        staff: {
          id: operator.staff.id,
          role: operator.staff.role,
          storeId: operator.staff.storeId ?? null,
          mustChangePin: Boolean(operator.staff.mustChangePin),
        },
        registerLocked: false,
        mustChangePin: Boolean(operator.staff.mustChangePin),
      }
    : {
        state: (operator?.state ?? 'absent') as 'absent' | 'invalid',
        staff: null,
        registerLocked: operator?.state === 'invalid',
        mustChangePin: false,
      }

  // The same request-access snapshot requireSubscription enforces, so a client
  // can show an activation gate instead of discovering it through 402s.
  const access = req.accessContext?.subscription
  const subscription = access
    ? { accessAllowed: access.accessAllowed, graceUntil: access.graceUntil ? new Date(access.graceUntil).toISOString() : null }
    : undefined

  return res.json({
    subscription,
    staff: {
      id: staff?.id ?? null,
      name: staff?.name ?? null,
      role: req.actingStaff?.role ?? req.user!.role,
    },
    tenant: { id: tenant.id, businessName: tenant.business_name, locality },
    store: store
      ? {
          id: store.id,
          name: store.name,
          locality: [store.city, store.state].filter(Boolean).join(', ') || null,
          combinedTaxRatePercent: new Prisma.Decimal(store.tax_rate_state)
            .plus(store.tax_rate_county)
            .plus(store.tax_rate_city)
            .plus(store.tax_rate_district)
            .times(100)
            .toFixed(4),
          // Keep the preview aligned with the GST document service. A missing
          // place of supply means the sale is local to the store's state.
          taxTreatment: statesMatch(store.state ?? tenant.state, store.place_of_supply ?? store.state ?? tenant.state)
            ? 'cgst_sgst'
            : 'igst',
        }
      : null,
    stores: stores.map((row: any) => ({
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      country: row.country,
      isActive: row.is_active,
      isOwnStore: row.id === ownStoreId,
    })),
    region: ['IN', 'INDIA'].includes(String(tenant.country).toUpperCase()) ? 'IN' : 'US',
    permissions,
    capabilities,
    onboarding: {
      step: tenant.onboarding_step,
      completed: tenant.onboarding_completed_at !== null,
    },
    operator: operatorJson,
  })
})

export default router
