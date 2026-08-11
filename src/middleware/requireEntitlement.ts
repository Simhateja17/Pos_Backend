import type { NextFunction, Request, Response } from 'express'
import {
  decideEntitlement,
  getEntitlementSummary,
  usageForEntitlement,
  type EntitlementDecision,
  type EntitlementSummary,
} from '../services/entitlements'
import type { EntitlementKey } from '../services/billingCatalog'

export const ENTITLEMENT_LIMIT_ERROR_CODE = 'entitlement_limit_reached' as const

export type EntitlementCheck = {
  summary: EntitlementSummary
  decision: EntitlementDecision
}

export function checkEntitlement(
  summary: EntitlementSummary,
  key: EntitlementKey,
  label?: string,
): EntitlementCheck | null {
  const usage = usageForEntitlement(summary, key)
  if (usage === null) return null
  return {
    summary,
    decision: decideEntitlement(key, summary.snapshot.limits[key], usage, label),
  }
}

function blockedResponse(res: Response, check: EntitlementCheck) {
  return res.status(403).json({
    error: check.decision.reason,
    code: ENTITLEMENT_LIMIT_ERROR_CODE,
    entitlement: check.decision.key,
    limit: check.decision.limit,
    usage: check.decision.usage,
  })
}

export function requireEntitlement(key: EntitlementKey, label?: string) {
  return async function entitlementMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })

    try {
      const summary = await getEntitlementSummary(req.user.tenantId)
      if (!summary.access.accessAllowed) {
        return res.status(402).json({
          error: 'An active subscription or trial is required to use this entitlement.',
          code: 'billing_required',
          entitlement: key,
        })
      }

      const check = checkEntitlement(summary, key, label)
      // Future resources intentionally have no implemented usage source. A
      // middleware accidentally attached to one of them must not invent a
      // count or block a route on an arbitrary placeholder.
      if (!check) return next()
      if (!check.decision.allowed) return blockedResponse(res, check)

      res.locals.entitlement = summary
      res.locals.entitlementCheck = check
      return next()
    } catch (error) {
      return next(error)
    }
  }
}

/**
 * These narrow aliases are the intended insertion points for the integrator:
 * mount the user/register/location guard before the corresponding create
 * handler, and still perform the same check inside a transaction if the route
 * can create concurrently. POS sales must use reservePosTransaction() inside
 * their existing transaction; this preflight alone is not a concurrency guard.
 */
export const requireUserEntitlement = requireEntitlement('maxActiveUsers', 'Active user')
export const requireRegisterEntitlement = requireEntitlement('maxActiveRegisters', 'Active register')
export const requireLocationEntitlement = requireEntitlement('maxLocations', 'Active location')
export const requirePosTransactionEntitlement = requireEntitlement('monthlyPosTransactions', 'POS transactions')
