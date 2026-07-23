import type { NextFunction, Request, Response } from 'express'

/**
 * Fixed 3-tier role hierarchy (owner >= manager >= cashier), per Phase 1
 * decisions. Higher rank = more privilege.
 */
export const ROLE_RANK = { cashier: 0, manager: 1, owner: 2 } as const

/**
 * requireRole(min) — Express middleware factory enforcing AUTH-02's
 * server-side role gating.
 *
 * SECURITY (T-1-06 / acting-identity fallback): gating always checks the
 * PIN-switched acting identity (`req.actingStaff.role`) FIRST when present,
 * falling back to the terminal's own long-lived session role
 * (`req.user.role`) only when no PIN-switch is active. This ensures a
 * cashier who has PIN-switched into an owner's terminal session is still
 * gated as a cashier, not the terminal's underlying owner session.
 */
export function requireRole(min: keyof typeof ROLE_RANK) {
  return (req: Request, res: Response, next: NextFunction) => {
    const actingRole = req.actingStaff?.role ?? req.user?.role

    if (!actingRole) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (ROLE_RANK[actingRole] < ROLE_RANK[min]) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }

    next()
  }
}
