export const OPEN_SUBSCRIPTION_STATUSES = ['created', 'authenticated', 'active', 'pending', 'halted'] as const

export type SubscriptionAccess = {
  entitlement: 'active' | 'grace' | 'blocked'
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
