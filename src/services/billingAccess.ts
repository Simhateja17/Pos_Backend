export const OPEN_SUBSCRIPTION_STATUSES = ['created', 'authenticated', 'active', 'pending', 'halted'] as const

export type SubscriptionAccess = {
  entitlement: 'active' | 'grace' | 'blocked'
  accessAllowed: boolean
  graceUntil: Date | null
}

export type TrialAccess = {
  entitlement: 'active' | 'blocked'
  accessAllowed: boolean
  graceUntil: Date | null
}

/**
 * Prisma model reads normally expose timestamps as `Date`, while raw SQL
 * reads can expose the same PostgreSQL timestamptz as an ISO string depending
 * on the driver/adapter in use. Authorization must apply the expiry boundary
 * consistently in both cases; treating a string as "no expiry" would leave an
 * expired trial open until some unrelated request happened to clean it up.
 */
function timestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Pure entitlement projection shared by the billing API and the consolidated
 * request-authorization transaction. Keeping this rule in one place prevents
 * a protected route and GET /billing/status from disagreeing about access.
 */
export function subscriptionAccessForRow(row: any, now = new Date()): SubscriptionAccess {
  if (!row) return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
  if (row.entitlement_status === 'active') {
    return { entitlement: 'active', accessAllowed: true, graceUntil: null }
  }

  const graceUntil = timestamp(row.grace_until_at)
  if (row.entitlement_status === 'grace' && graceUntil && graceUntil > now) {
    return { entitlement: 'grace', accessAllowed: true, graceUntil }
  }
  return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
}

/**
 * Trials are a separate source of purchased entitlement snapshots. They have
 * no provider grace state: an active trial is usable until its end instant,
 * and an expired/cancelled trial is blocked. Keeping this beside the paid
 * subscription projection makes the access boundary explicit and testable.
 */
export function trialAccessForRow(row: any, now = new Date()): TrialAccess {
  if (!row || row.status !== 'active') {
    return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
  }

  const endsAt = timestamp(row.ends_at)
  // A non-null malformed timestamp is not an unbounded trial. Fail closed so
  // a driver/type regression cannot grant access beyond the intended end.
  if (row.ends_at !== null && row.ends_at !== undefined && !endsAt) {
    return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
  }
  if (endsAt && endsAt <= now) {
    return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
  }

  return { entitlement: 'active', accessAllowed: true, graceUntil: null }
}
