import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

/**
 * Grants a seeded tenant an active subscription.
 *
 * `requireSubscription` gates every operational POS route on
 * `subscriptionAccessForRow`, which returns accessAllowed only for a
 * billing_subscriptions row whose `entitlement_status` is 'active' (or
 * 'grace' with an unexpired `grace_until_at`). `seedTwoTenants` creates no
 * billing rows at all, so a freshly seeded tenant is `blocked` and every such
 * route answers 402 before the test's actual assertion is ever reached.
 *
 * That is a pre-existing gap between the billing gate and the seed fixture —
 * not an auth problem — so it is fixed here rather than by weakening the gate
 * or asserting 402 in suites that are about something else. This helper
 * belongs in seed.ts proper; it is kept separate only to avoid colliding with
 * the Phase 8 edits in flight on that file.
 *
 * Uses DATABASE_URL (session/superuser) for the same reason seed.ts does:
 * fixture rows must be insertable without app.tenant_id pre-configured. No
 * app runtime code path uses this connection.
 *
 * No cleanup function is needed — `cleanupSeed` deletes the tenant, and the
 * row's tenant_id FK cascades.
 */
const superPrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

export async function grantActiveSubscription(tenantId: string): Promise<void> {
  const now = new Date()
  const oneYearOut = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)

  await superPrisma.billing_subscriptions.create({
    data: {
      tenant_id: tenantId,
      provider: 'razorpay',
      // Namespaced so a fixture row is never mistaken for a real provider
      // record, and unique per tenant so parallel suites cannot collide.
      provider_subscription_id: `test_fixture_sub_${tenantId}`,
      provider_plan_id: 'test_fixture_plan',
      region: 'IN',
      plan_key: 'test_fixture',
      billing_cycle: 'monthly',
      currency: 'INR',
      base_amount_minor: 0n,
      tax_amount_minor: 0n,
      total_amount_minor: 0n,
      tax_rate_bps: 0,
      status: 'active',
      entitlement_status: 'active',
      current_start_at: now,
      current_end_at: oneYearOut,
    },
  })
}
