import type { NextFunction, Request, Response } from 'express'
import { verifyOperatorToken } from './pinSwitch'

/**
 * operatorContext — verifies the X-Operator-Token header (issued by
 * POST /terminal/pin/switch) on every subsequent request, populating
 * req.actingStaff ONLY from a cryptographically verified token.
 *
 * SECURITY (T-1-06): req.actingStaff is never set from an unsigned client
 * claim. No header present is a normal no-op (most requests are the
 * terminal's own owner/manager session with no active PIN-switch) — but a
 * PRESENT-but-invalid/tampered/expired token is rejected loudly with 401,
 * never silently ignored, since silently falling through could mask an
 * attempted spoof.
 *
 * Mounted in server.ts directly after authMiddleware and before the routes
 * aggregator (01-08 wiring), so req.actingStaff is available to every
 * route's requireRole check.
 */
export function operatorContext(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['x-operator-token']

  if (!token) {
    return next()
  }

  const tokenString = Array.isArray(token) ? token[0] : token
  const claims = verifyOperatorToken(tokenString)

  if (!claims) {
    return res.status(401).json({ error: 'Invalid operator session' })
  }

  req.actingStaff = { id: claims.id, role: claims.role }
  next()
}
