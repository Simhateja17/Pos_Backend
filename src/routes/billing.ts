import { Router } from 'express'
import {
  BillingRegionSchema,
  CancelSubscriptionSchema,
  CreateSubscriptionSchema,
  VerifySubscriptionSchema,
} from '../contracts/schemas/billing'
import { requireRole } from '../middleware/requireRole'
import { cancelSubscription, createSubscription, getBillingStatus, billingMode, regionForCountry, verifySubscription } from '../services/billing'
import { getPlans, toPlanOption } from '../services/billingCatalog'
import { activateFreeSubscription, entitlementStatusFields, getEntitlementSummary } from '../services/entitlements'
import { forTenant } from '../db/tenantClient'

const router = Router()

router.get('/plans', async (req, res) => {
  const requested = BillingRegionSchema.safeParse(req.query.region)
  const client = forTenant(req.user!.tenantId) as any
  const tenant = await client.tenants.findFirst({ where: { id: req.user!.tenantId }, select: { country: true } })
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const tenantRegion = regionForCountry(tenant.country)
  if (requested.success && requested.data !== tenantRegion) {
    return res.status(400).json({ error: 'The selected billing region does not match this account' })
  }
  return res.json({ mode: billingMode(), region: tenantRegion, plans: getPlans(tenantRegion).map(toPlanOption) })
})

router.get('/status', async (req, res) => {
  const billing = await getBillingStatus(req.user!.tenantId)
  const entitlements = await getEntitlementSummary(req.user!.tenantId)
  return res.json({
    ...billing,
    entitlement: entitlements.access.entitlement,
    accessAllowed: entitlements.access.accessAllowed,
    graceUntil: entitlements.access.graceUntil?.toISOString() ?? null,
    ...entitlementStatusFields(entitlements),
  })
})

router.post('/subscription', requireRole('owner'), async (req, res) => {
  const parsed = CreateSubscriptionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid subscription request' })
  if (parsed.data.planKey === 'free') {
    return res.status(201).json(await activateFreeSubscription(req.user!.tenantId, parsed.data))
  }
  return res.status(201).json(await createSubscription(req.user!.tenantId, parsed.data))
})

router.post('/subscription/verify', requireRole('owner'), async (req, res) => {
  const parsed = VerifySubscriptionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Razorpay verification request' })
  return res.json(await verifySubscription(req.user!.tenantId, parsed.data))
})

router.post('/subscription/cancel', requireRole('owner'), async (req, res) => {
  const parsed = CancelSubscriptionSchema.safeParse(req.body ?? {})
  if (!parsed.success) return res.status(400).json({ error: 'Cancellation must be scheduled at the end of the current cycle' })
  return res.json(await cancelSubscription(req.user!.tenantId))
})

export default router
