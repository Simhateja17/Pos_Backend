import type { NextFunction, Request, Response } from 'express'
import { verifyOperatorToken } from './pinSwitch'
import { forTenantTransaction } from '../db/tenantClient'
import { findPairedTerminal } from '../lib/counterDevice'

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
 * SECURITY (CR-01): the token's `tenant_id` claim MUST match the current
 * session's req.user.tenantId (populated exclusively from a verified
 * Supabase JWT by authMiddleware, never client input) before the token is
 * trusted. Without this check, an operator token minted while validated
 * inside Tenant A could be replayed as X-Operator-Token against a session
 * authenticated in Tenant B, escalating that unrelated request to whatever
 * role the token claims. Because this check depends on req.user, this
 * middleware MUST be mounted AFTER authMiddleware on any route that uses it
 * (see routes/index.ts) — it is no longer mounted globally ahead of
 * authMiddleware in server.ts.
 */
export async function operatorContext(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['x-operator-token']

  if (!token) {
    return next()
  }

  // Normal protected routes arrive with a server-owned snapshot produced by
  // authMiddleware. Reuse it so this gate does not start a second transaction.
  if (req.accessContext) {
    const cached = req.accessContext.operator
    if (cached.state !== 'valid') {
      return res.status(401).json({ error: 'Invalid operator session' })
    }
    req.actingStaff = cached.staff
    return next()
  }

  const tokenString = Array.isArray(token) ? token[0] : token
  const claims = verifyOperatorToken(tokenString)

  if (!claims || !req.user || claims.tenantId !== req.user.tenantId) {
    return res.status(401).json({ error: 'Invalid operator session' })
  }

  if (!claims.sessionId) {
    req.actingStaff = { id: claims.id, role: claims.role, mustChangePin: claims.mustChangePin }
    return next()
  }

  // New operator tokens are bound to a durable staff_sessions row. This makes
  // an explicit logout, deactivation, or replacement of the active cashier
  // take effect immediately instead of waiting for the JWT's expiry.
  const valid = await forTenantTransaction(req.user.tenantId, async (tx) => {
    const session = await tx.staff_sessions.findFirst({
      where: { id: claims.sessionId, logged_out_at: null },
      include: { staff_members: { select: { id: true, role: true, is_active: true } } },
    })
    const pairedTerminal = session?.terminal_id ? await findPairedTerminal(tx, req) : null

    if (
      !session ||
      !session.staff_members?.is_active ||
      session.staff_members.id !== claims.id ||
      session.staff_members.role !== claims.role ||
      (session.terminal_id !== null && pairedTerminal?.id !== session.terminal_id)
    ) {
      return false
    }

    await tx.staff_sessions.update({
      where: { id: claims.sessionId },
      data: { last_seen_at: new Date() },
    })
    return true
  })

  if (!valid) {
    return res.status(401).json({ error: 'Invalid operator session' })
  }

  req.actingStaff = {
    id: claims.id,
    role: claims.role,
    sessionId: claims.sessionId,
    mustChangePin: claims.mustChangePin,
  }
  return next()
}
