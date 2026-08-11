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
 * Pure entitlement projection shared by the billing API and the consolidated
 * request-authorization transaction. Keeping this rule in one place prevents
 * a protected route and GET /billing/status from disagreeing about access.
 */
export function subscriptionAccessForRow(row: any, now = new Date()): SubscriptionAccess {
  if (!row) return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
  if (row.entitlement_status === 'active') {
    return { entitlement: 'active', accessAllowed: true, graceUntil: null }
  }

  const graceUntil = row.grace_until_at instanceof Date ? row.grace_until_at : null
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

  const endsAt = row.ends_at instanceof Date ? row.ends_at : null
  if (endsAt && endsAt <= now) {
    return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
  }

  return { entitlement: 'active', accessAllowed: true, graceUntil: null }
}
