import type { NextFunction, Request, Response } from 'express'
import { getBillingStatus } from '../services/billing'

/**
 * Application access is an entitlement, not a client-side route decision.
 * Billing setup and onboarding remain reachable so an owner can pay or retry;
 * operational POS APIs use this middleware and accept the explicitly approved
 * renewal grace period as accessAllowed.
 */
export async function requireSubscription(req: Request, res: Response, next: NextFunction) {
  const status = await getBillingStatus(req.user!.tenantId)
  if (!status.accessAllowed) {
    return res.status(402).json({
      error: 'An active subscription is required to access the application',
      code: 'billing_required',
      entitlement: status.entitlement,
    })
  }
  return next()
}
