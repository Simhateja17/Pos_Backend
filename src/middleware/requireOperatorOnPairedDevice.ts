import type { NextFunction, Request, Response } from 'express'
import { forTenant } from '../db/tenantClient'
import { findPairedTerminal, isRegisterLocked } from '../lib/counterDevice'
import { ROLE_RANK } from './requireRole'

function locked(res: Response) {
  return res.status(423).json({
    code: 'REGISTER_LOCKED',
    error: 'This register is locked. Enter a staff PIN to continue.',
  })
}

/**
 * A paired browser is a shared register, not an owner's personal back-office
 * session. The organisation JWT stays alive underneath, but it must not be
 * usable to bypass the register lock after a cashier signs out.
 *
 * Keep the PIN bootstrap routes (staff roster, terminal discovery and PIN
 * switch) outside this middleware. Everything mounted behind it requires a
 * verified operator token whenever the browser cookie resolves to a counter.
 * Unpaired browsers remain usable for first-time setup and owner back-office
 * work.
 */
export async function requireOperatorOnPairedDevice(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' })

  // authMiddleware already resolved the device inside the consolidated access
  // transaction. Retain the fallback for standalone mounting/tests only.
  const pairedTerminalId = req.accessContext
    ? req.accessContext.pairedTerminalId
    : (await findPairedTerminal(forTenant(req.user.tenantId) as any, req))?.id ?? null

  if ((pairedTerminalId || isRegisterLocked(req, req.user.tenantId)) && !req.actingStaff) {
    return locked(res)
  }

  return next()
}

/**
 * Recovery seam for a store that paired a browser before creating its first
 * PIN. It permits only owner/manager-backed member setup while the tenant has
 * zero active PIN-ready staff. The exception closes itself as soon as the
 * first PIN is saved.
 */
export async function requireOperatorOrFirstPinSetup(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
  if (req.actingStaff) return next()

  const client = forTenant(req.user.tenantId) as any
  const pairedTerminalId = req.accessContext
    ? req.accessContext.pairedTerminalId
    : (await findPairedTerminal(client, req))?.id ?? null
  if (!pairedTerminalId && !isRegisterLocked(req, req.user.tenantId)) return next()
  if (ROLE_RANK[req.user.role] < ROLE_RANK.manager) return locked(res)

  const pinReadyStaff = await client.staff_members.count({
    where: { is_active: true, pin_hash: { not: null } },
  })
  if (pinReadyStaff === 0) return next()
  return locked(res)
}
