import { Router } from 'express'
import bcrypt from 'bcrypt'
import { validatePin, signOperatorToken } from '../middleware/pinSwitch'
import { ChangeOperatorPinSchema, PinSwitchSchema } from '../contracts/schemas/pin'
import { requireRole } from '../middleware/requireRole'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { findPairedTerminal } from '../lib/counterDevice'
import { consumeRateLimit } from '../lib/rateLimit'

const router = Router()
const PIN_SWITCH_WINDOW_MS = 15 * 60 * 1000
const PIN_SWITCH_TARGET_LIMIT = 10
const PIN_SWITCH_ACTOR_LIMIT = 30

/**
 * POST /switch — PIN-switch the acting operator on a shared terminal.
 * Requires authMiddleware to have already run (the terminal's own
 * long-lived owner/manager session). Does NOT create a new Supabase Auth
 * session — issues a short-lived signed operator token instead (D-09/D-10).
 *
 * SECURITY (T-1-09): 'not_found' and 'incorrect' map to the SAME generic
 * error copy so an attacker cannot distinguish "PIN not yet provisioned"
 * from "wrong PIN".
 */
router.post('/switch', async (req, res) => {
  const parsed = PinSwitchSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { staffId, pin, sessionType } = parsed.data
  const targetLimit = consumeRateLimit(
    `pin-switch-target:${req.user.tenantId}:${staffId}`,
    PIN_SWITCH_TARGET_LIMIT,
    PIN_SWITCH_WINDOW_MS,
  )
  const actorLimit = consumeRateLimit(
    `pin-switch-actor:${req.user.tenantId}:${req.user.id}:${req.ip}`,
    PIN_SWITCH_ACTOR_LIMIT,
    PIN_SWITCH_WINDOW_MS,
  )
  if (!targetLimit.allowed || !actorLimit.allowed) {
    const retryAfter = Math.max(targetLimit.retryAfterSeconds, actorLimit.retryAfterSeconds)
    res.set('Retry-After', String(retryAfter))
    return res.status(429).json({ error: 'Too many PIN attempts. Please try again later.' })
  }

  const client = forTenant(req.user.tenantId) as any
  const terminal = await findPairedTerminal(client, req)

  const result = await validatePin(req.user.tenantId, staffId, pin)

  if (!result.ok) {
    const message =
      result.reason === 'locked'
        ? 'Too many attempts. Ask a manager to unlock this terminal.'
        : 'Incorrect PIN — try again.'
    return res.status(401).json({ error: message })
  }

  const openShift = terminal
    ? await client.shifts.findFirst({
        where: { terminal_id: terminal.id, closed_at: null },
        select: { id: true },
      })
    : null
  const session = await forTenantTransaction(req.user.tenantId, async (tx) => {
    const now = new Date()
    if (terminal && sessionType === 'register') {
      await tx.staff_sessions.updateMany({
        where: { terminal_id: terminal.id, logged_out_at: null },
        data: { logged_out_at: now, logout_reason: 'interrupted', last_seen_at: now },
      })
    }
    return tx.staff_sessions.create({
      data: {
        tenant_id: req.user!.tenantId,
        staff_id: result.staff.id,
        terminal_id: terminal?.id ?? null,
        shift_id: openShift?.id ?? null,
        logged_in_at: now,
        last_seen_at: now,
      },
    })
  })

  const operatorClaims = { ...result.staff, sessionId: session.id }
  return res.status(200).json({
    operatorToken: signOperatorToken(operatorClaims, req.user.tenantId),
    staff: { ...result.staff, mustChangePin: Boolean(result.staff.mustChangePin) },
  })
})

router.post('/change', async (req, res) => {
  const parsed = ChangeOperatorPinSchema.safeParse(req.body)
  if (!parsed.success || !req.user || !req.actingStaff?.id) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' })
  }

  const client = forTenant(req.user.tenantId) as any
  await client.staff_members.update({
    where: { id: req.actingStaff.id },
    data: {
      pin_hash: await bcrypt.hash(parsed.data.pin, 12),
      pin_must_change: false,
      pin_attempts: 0,
      pin_locked_until: null,
    },
  })
  return res.json({ ok: true })
})

router.post('/logout', async (req, res) => {
  if (req.user && req.actingStaff?.sessionId) {
    const client = forTenant(req.user.tenantId) as any
    await client.staff_sessions.updateMany({
      where: { id: req.actingStaff.sessionId, logged_out_at: null },
      data: { logged_out_at: new Date(), logout_reason: 'explicit', last_seen_at: new Date() },
    })
  }
  return res.json({ ok: true })
})

/** Manager/owner audit view of the cashier sessions recorded for the store. */
router.get('/sessions', requireRole('manager'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const sessions = await client.staff_sessions.findMany({
    orderBy: { logged_in_at: 'desc' },
    take: 200,
  })
  const [staff, terminals] = await Promise.all([
    client.staff_members.findMany({ select: { id: true, name: true } }),
    client.terminals.findMany({ select: { id: true, name: true } }),
  ])
  const staffNames = new Map(staff.map((row: any) => [row.id, row.name]))
  const terminalNames = new Map(terminals.map((row: any) => [row.id, row.name]))

  return res.json(
    sessions.map((row: any) => ({
      id: row.id,
      staffId: row.staff_id,
      staffName: staffNames.get(row.staff_id) ?? null,
      terminalId: row.terminal_id ?? null,
      terminalName: row.terminal_id ? terminalNames.get(row.terminal_id) ?? null : null,
      shiftId: row.shift_id ?? null,
      loggedInAt: row.logged_in_at.toISOString(),
      loggedOutAt: row.logged_out_at ? row.logged_out_at.toISOString() : null,
      logoutReason: row.logout_reason ?? null,
      lastSeenAt: row.last_seen_at.toISOString(),
    })),
  )
})

export default router
