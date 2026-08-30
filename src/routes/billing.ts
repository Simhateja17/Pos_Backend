import { Router } from 'express'
import {
  BillingRegionSchema,
  CancelSubscriptionSchema,
  CreateSubscriptionSchema,
  VerifySubscriptionSchema,
} from '../contracts/schemas/billing'
import { requireRole } from '../middleware/requireRole'
import { cancelSubscription, createSubscription, getBillingStatus, billingMode, regionForCountry, verifySubscription } from '../services/billing'
import { canonicalBillingRegion, getPlan, getPlans, toPlanOption } from '../services/billingCatalog'
import { entitlementStatusFields, getEntitlementSummary } from '../services/entitlements'
import { forTenant } from '../db/tenantClient'

const router = Router()

router.get('/plans', async (req, res) => {
  const requested = BillingRegionSchema.safeParse(req.query.region)
  const client = forTenant(req.user!.tenantId) as any
  const tenant = await client.tenants.findFirst({ where: { id: req.user!.tenantId }, select: { country: true } })
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const tenantRegion = regionForCountry(tenant.country)
  if (requested.success && canonicalBillingRegion(requested.data) !== canonicalBillingRegion(tenantRegion)) {
    return res.status(400).json({ error: 'The selected billing region does not match this account' })
  }
  const offerId = typeof req.query.offer === 'string' ? req.query.offer : null
  if (offerId && /^[0-9a-f-]{36}$/i.test(offerId)) {
    const offers = await client.$queryRaw<any[]>`
      SELECT * FROM public.private_billing_offers
      WHERE id = ${offerId}::uuid AND tenant_id = ${req.user!.tenantId}::uuid
        AND status = 'offered' AND latest_activation_at > now()
      LIMIT 1
    `
    const offer = offers[0]
    if (!offer) return res.status(404).json({ error: 'This private offer is no longer available' })
    const base = getPlan(tenantRegion, offer.base_plan_key)
    if (!base) return res.status(409).json({ error: 'The base plan for this offer is unavailable' })
    const option = toPlanOption({
      ...base,
      name: `${base.name} · Private offer`,
      description: 'Your negotiated Ambel subscription offer.',
      popular: false,
      entitlements: {
        ...base.entitlements,
        maxLocations: offer.included_location_count,
        maxActiveRegisters: offer.included_register_count,
        maxActiveUsers: offer.included_user_count,
      },
      features: [
        `${offer.included_location_count} locations`,
        `${offer.included_register_count} active registers`,
        `${offer.included_user_count} active users`,
        ...base.features.filter((feature) => !/location|register|user/i.test(feature)),
      ],
      monthly: offer.billing_cycle === 'monthly'
        ? { amountMinor: Number(offer.total_amount_minor), taxRateBps: 0, providerPlanId: offer.provider_plan_id }
        : { amountMinor: 0 },
      annual: offer.billing_cycle === 'annual'
        ? { amountMinor: Number(offer.total_amount_minor), taxRateBps: 0, providerPlanId: offer.provider_plan_id }
        : { amountMinor: 0 },
    })
    const offeredCycle: 'monthly' | 'annual' = offer.billing_cycle === 'annual' ? 'annual' : 'monthly'
    option[offeredCycle] = {
      baseAmountMinor: Number(offer.negotiated_base_amount_minor),
      taxAmountMinor: Number(offer.tax_amount_minor),
      totalAmountMinor: Number(offer.total_amount_minor),
      taxRateBps: offer.tax_rate_bps,
      taxMode: 'exclusive',
      taxLabel: offer.tax_rate_bps > 0 ? `GST (${offer.tax_rate_bps / 100}%)` : 'No tax',
    }
    return res.json({ mode: billingMode(), region: tenantRegion, plans: [option], privateOfferId: offer.id, trialDays: offer.trial_days, latestActivationAt: offer.latest_activation_at })
  }
  return res.json({ mode: billingMode(), region: tenantRegion, plans: getPlans(tenantRegion).map(toPlanOption) })
})

router.get('/private-offers', requireRole('owner'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const offers = await client.$queryRaw<any[]>`
    SELECT id, base_plan_key, billing_cycle, currency, negotiated_base_amount_minor,
      tax_amount_minor, total_amount_minor, tax_rate_bps, included_location_count,
      included_register_count, included_user_count, trial_days, latest_activation_at,
      price_validity, fixed_billing_cycles, status, created_at
    FROM public.private_billing_offers
    WHERE tenant_id = ${req.user!.tenantId}::uuid AND status IN ('offered', 'accepted')
    ORDER BY created_at DESC
  `
  return res.json({ offers: offers.map((offer: any) => ({
    id: offer.id, basePlanKey: offer.base_plan_key, billingCycle: offer.billing_cycle,
    currency: offer.currency, baseAmountMinor: Number(offer.negotiated_base_amount_minor),
    taxAmountMinor: Number(offer.tax_amount_minor), totalAmountMinor: Number(offer.total_amount_minor),
    taxRateBps: offer.tax_rate_bps, includedLocations: offer.included_location_count,
    includedRegisters: offer.included_register_count, includedUsers: offer.included_user_count,
    trialDays: offer.trial_days, latestActivationAt: offer.latest_activation_at,
    priceValidity: offer.price_validity, fixedBillingCycles: offer.fixed_billing_cycles,
    status: offer.status, createdAt: offer.created_at,
  })) })
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
