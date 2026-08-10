import { OPEN_SUBSCRIPTION_STATUSES } from './billingAccess'

export type StoreAllowance = {
  /** Active shops the business currently has. */
  used: number
  /** Shops the plan covers, including any add-ons. */
  limit: number
  /** Whether one more shop may be opened right now. */
  canAddStore: boolean
  /** Included in the plan, before add-ons. Shown so an upgrade prompt can be specific. */
  includedInPlan: number
  additionalPurchased: number
}

/**
 * How many shops a business may run (Phase 8 task 12).
 *
 * The rule is a COUNT AND A LIMIT, deliberately independent of what anything
 * costs. Tier pricing is not settled, and this code should not need to change
 * when it is — what a plan includes is a catalog concern
 * (services/billingCatalog.ts), and what a customer bought is recorded on
 * their subscription row (migration 0053).
 *
 * COUNTS ACTIVE SHOPS ONLY. A deactivated outlet is not trading and should not
 * consume an allowance — otherwise an owner who closes a shop keeps paying for
 * it, discovers they cannot open its replacement, and is entirely right to be
 * annoyed.
 *
 * NO SUBSCRIPTION MEANS ONE SHOP. A tenant mid-signup, or on a lapsed plan,
 * can keep the shop they have and cannot open more. Defaulting to unlimited
 * would make the limit unenforceable exactly when billing is broken, which is
 * when it matters.
 */
export async function storeAllowance(tx: any, tenantId: string): Promise<StoreAllowance> {
  const [activeStores, subscription] = await Promise.all([
    tx.stores.count({ where: { is_active: true } }),
    tx.billing_subscriptions.findFirst({
      where: { tenant_id: tenantId, status: { in: [...OPEN_SUBSCRIPTION_STATUSES] } },
      orderBy: { updated_at: 'desc' },
      select: { included_store_count: true, additional_store_count: true },
    }),
  ])

  const includedInPlan = subscription?.included_store_count ?? 1
  const additionalPurchased = subscription?.additional_store_count ?? 0
  const limit = includedInPlan + additionalPurchased

  return {
    used: activeStores,
    limit,
    canAddStore: activeStores < limit,
    includedInPlan,
    additionalPurchased,
  }
}

/**
 * The refusal message an owner sees when they hit the limit.
 *
 * Names the number they are on and tells them what to do about it. A bare
 * "limit reached" leaves them guessing whether it is a bug, and a shop they
 * cannot open with no explanation is a support ticket.
 */
export function storeLimitMessage(allowance: StoreAllowance): string {
  return (
    `Your plan covers ${allowance.limit} ` +
    `${allowance.limit === 1 ? 'store' : 'stores'} and you have ${allowance.used}. ` +
    'Upgrade your plan or add a store to your subscription to open another.'
  )
}
