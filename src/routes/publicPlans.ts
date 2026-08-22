import { Router } from 'express'
import { BillingRegionSchema } from '../contracts/schemas/billing'
import { billingMode } from '../services/billing'
import { canonicalBillingRegion, getPlans, toPlanOption } from '../services/billingCatalog'

const router = Router()

// Unauthenticated by design: the marketing site needs live pricing for an
// anonymous visitor, who has no tenant or session yet. Region comes from the
// caller's own detection (IP geolocation, switcher choice), not from any
// server-side identity — this route trusts whatever region it's asked for
// and returns that region's catalog, nothing tenant-specific.
router.get('/plans', async (req, res) => {
  const requested = BillingRegionSchema.safeParse(req.query.region)
  // Ambiguous/missing detection defaults to International, matching the
  // marketing site's own fallback (a wrong INR price reads as broken; a
  // wrong USD price just looks like "before we knew where you were").
  const region = canonicalBillingRegion(requested.success ? requested.data : 'INTL')
  return res.json({ mode: billingMode(), region, plans: getPlans(region).map(toPlanOption) })
})

export default router
