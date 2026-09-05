import { activeStoreId } from '../middleware/storeContext'
import { Router, type Request, type Response } from 'express'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import { CreateTerminalSchema, UpdateTerminalSchema } from '../contracts/schemas/terminal'
import {
  createCounterDeviceToken,
  findPairedTerminal,
  getCounterDeviceToken,
  hashCounterDeviceToken,
  setCounterDeviceCookie,
  isRegisterLocked,
} from '../lib/counterDevice'
import { requireOperatorOnPairedDevice } from '../middleware/requireOperatorOnPairedDevice'

const router = Router()

/**
 * Counters are a single-store surface, same as settings.ts's singleStoreId:
 * `X-Store-Id: all` has no single till list to show. Reject it before any
 * query runs and give the client the same machine-readable code settings.ts
 * uses, so the frontend can show its established "choose a store" picker
 * instead of a generic load failure.
 */
function singleStoreId(req: Request, res: Response): string | null {
  if (req.storeContext?.scope === 'business') {
    res.status(400).json({ code: 'choose_store', error: 'Choose a store to manage its counters' })
    return null
  }
  try {
    return activeStoreId(req)
  } catch {
    res.status(400).json({ code: 'choose_store', error: 'Choose a store to manage its counters' })
    return null
  }
}

function toTerminalJson(row: any, hasOpenShift: boolean, currentDeviceHash?: string, activeCashierName?: string | null) {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    hasOpenShift,
    createdAt: row.created_at.toISOString(),
    cashMode: row.cash_mode === 'none' ? 'none' : 'cash',
    isPaired: Boolean(row.device_token_hash),
    isCurrentDevice: Boolean(currentDeviceHash && row.device_token_hash === currentDeviceHash),
    deviceLastSeenAt: row.device_last_seen_at ? row.device_last_seen_at.toISOString() : null,
    activeCashierName: activeCashierName ?? null,
  }
}

async function listWithOpenShifts(client: any, storeId: string, currentDeviceHash?: string) {
  const [terminals, openShifts, activeSessions, staff] = await Promise.all([
    client.terminals.findMany({ where: { store_id: storeId }, orderBy: [{ name: 'asc' }] }),
    client.shifts.findMany({ where: { store_id: storeId, closed_at: null }, select: { terminal_id: true } }),
    client.staff_sessions.findMany({
      where: { logged_out_at: null, staff_members: { store_id: storeId } },
      select: { terminal_id: true, staff_id: true },
    }),
    client.staff_members.findMany({ where: { store_id: storeId }, select: { id: true, name: true } }),
  ])
  const busy = new Set(openShifts.map((row: any) => row.terminal_id).filter(Boolean))
  const staffNames = new Map<string, string>(staff.map((row: any) => [row.id, row.name] as [string, string]))
  const activeCashiers = new Map<string, string>()
  activeSessions.forEach((row: any) => {
    if (row.terminal_id && !activeCashiers.has(row.terminal_id)) {
      activeCashiers.set(row.terminal_id, staffNames.get(row.staff_id) ?? 'Active operator')
    }
  })
  return terminals.map((row: any) =>
    toTerminalJson(row, busy.has(row.id), currentDeviceHash, activeCashiers.get(row.id) ?? null),
  )
}

/**
 * GET / — the tenant's till list. Read is open to every role: a cashier must
 * be able to see the terminals in order to pick one when opening a shift.
 * Mutations below are manager+ (owner/manager configure the store's counters).
 */
router.get('/', async (req, res) => {
  const storeId = singleStoreId(req, res)
  if (!storeId) return
  const client = forTenant(req.user!.tenantId) as any
  const token = getCounterDeviceToken(req)
  const currentDeviceHash = token ? hashCounterDeviceToken(token) : undefined

  // The unlocked cashier only needs the counter represented by this browser.
  // The no-operator lock screen intentionally still receives the full list so
  // an owner can pair an unassigned device during setup.
  if (req.actingStaff?.role === 'cashier') {
    const current = await findPairedTerminal(client, req)
    if (!current) return res.json([])
    const all = await listWithOpenShifts(client, storeId, currentDeviceHash)
    return res.json(all.filter((terminal: { id: string }) => terminal.id === current.id))
  }

  return res.json(await listWithOpenShifts(client, storeId, currentDeviceHash))
})

/** Resolve the counter represented by this browser/device cookie. */
router.get('/device', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const terminal = await findPairedTerminal(client, req)
  if (!terminal) return res.json({ terminal: null, isRegisterLocked: isRegisterLocked(req, req.user!.tenantId) })

  const openShift = await client.shifts.findFirst({
    where: { terminal_id: terminal.id, store_id: terminal.store_id, closed_at: null },
    select: { id: true },
  })
  return res.json({
    isRegisterLocked: isRegisterLocked(req, req.user!.tenantId),
    terminal: toTerminalJson(
      terminal,
      Boolean(openShift),
      terminal.device_token_hash,
      null,
    ),
  })
})

router.post('/', requireOperatorOnPairedDevice, requireRole('manager'), async (req, res) => {
  const parsed = CreateTerminalSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter a name for this counter.' })
  }
  const storeId = singleStoreId(req, res)
  if (!storeId) return

  const client = forTenant(req.user!.tenantId) as any
  try {
    const created = await client.terminals.create({
      data: {
        tenant_id: req.user!.tenantId,
        store_id: storeId,
        name: parsed.data.name,
        cash_mode: parsed.data.cashMode,
      },
    })
    return res.status(201).json(toTerminalJson(created, false))
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You already have a counter with that name' })
    }
    return res.status(500).json({ error: 'Could not create that counter' })
  }
})

/**
 * Pair this browser/device to a logical counter. Pairing is deliberately
 * replaceable: the owner/manager can move the same browser to another
 * counter, or pair a replacement browser to the counter after a failure.
 */
router.post('/:terminalId/pair', requireOperatorOnPairedDevice, requireRole('manager'), async (req, res) => {
  const storeId = singleStoreId(req, res)
  if (!storeId) return
  const client = forTenant(req.user!.tenantId) as any
  const pinReadyStaff = await client.staff_members.count({
    where: { store_id: storeId, is_active: true, pin_hash: { not: null } },
  })
  if (pinReadyStaff === 0) {
    return res.status(409).json({
      error: 'Set a counter PIN for at least one active staff member before pairing this device.',
    })
  }
  const target = await client.terminals.findFirst({
    where: { id: req.params.terminalId, store_id: storeId },
  })
  if (!target) return res.status(404).json({ error: 'Counter not found' })
  if (!target.is_active) return res.status(409).json({ error: 'Turn that counter on before pairing a device.' })

  const oldToken = getCounterDeviceToken(req)
  const newToken = createCounterDeviceToken()
  const newHash = hashCounterDeviceToken(newToken)

  const paired = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    const oldTerminal = oldToken
      ? await tx.terminals.findFirst({
          where: { device_token_hash: hashCounterDeviceToken(oldToken) },
          select: { id: true },
        })
      : null
    const affectedTerminalIds = [target.id]
    if (oldTerminal && oldTerminal.id !== target.id) affectedTerminalIds.push(oldTerminal.id)

    // Re-pairing is an explicit counter/device handover. Any operator who
    // was active on either side of that handover must log in again, otherwise
    // a stale tab could carry the previous cashier onto the new counter.
    await tx.staff_sessions.updateMany({
      where: { terminal_id: { in: affectedTerminalIds }, logged_out_at: null },
      data: { logged_out_at: new Date(), logout_reason: 'interrupted', last_seen_at: new Date() },
    })

    if (oldToken) {
      await tx.terminals.updateMany({
        where: { device_token_hash: hashCounterDeviceToken(oldToken) },
        data: { device_token_hash: null, device_paired_at: null },
      })
    }
    return tx.terminals.update({
      where: { id: target.id },
      data: {
        device_token_hash: newHash,
        device_paired_at: new Date(),
        device_last_seen_at: new Date(),
      },
    })
  })

  setCounterDeviceCookie(res, newToken)
  const openShift = await client.shifts.findFirst({
    where: { terminal_id: paired.id, store_id: paired.store_id, closed_at: null },
    select: { id: true },
  })
  return res.json(toTerminalJson(paired, Boolean(openShift), newHash, null))
})

router.patch('/:terminalId', requireOperatorOnPairedDevice, requireRole('manager'), async (req, res) => {
  const parsed = UpdateTerminalSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const storeId = singleStoreId(req, res)
  if (!storeId) return
  const client = forTenant(req.user!.tenantId) as any
  // RLS-scoped read first so another tenant's id cannot be renamed by guessing.
  const existing = await client.terminals.findFirst({
    where: { id: req.params.terminalId, store_id: storeId },
  })
  if (!existing) {
    return res.status(404).json({ error: 'Counter not found' })
  }

  // Deactivating a counter that is mid-shift would strand that drawer: the
  // cashier could no longer see the till they are reconciling against.
  if (parsed.data.isActive === false) {
    const openShift = await client.shifts.findFirst({
      where: { terminal_id: existing.id, closed_at: null },
    })
    if (openShift) {
      return res.status(409).json({
        error: 'This counter has a shift open on it. Close that shift before turning the counter off.',
      })
    }
  }

  try {
    const updated = await client.terminals.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.isActive !== undefined ? { is_active: parsed.data.isActive } : {}),
        ...(parsed.data.cashMode !== undefined ? { cash_mode: parsed.data.cashMode } : {}),
      },
    })
    const openShift = await client.shifts.findFirst({
      where: { terminal_id: updated.id, store_id: updated.store_id, closed_at: null },
      select: { id: true },
    })
    const token = getCounterDeviceToken(req)
    return res.json(
      toTerminalJson(updated, Boolean(openShift), token ? hashCounterDeviceToken(token) : undefined, null),
    )
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You already have a counter with that name' })
    }
    return res.status(500).json({ error: 'Could not update that counter' })
  }
})

/**
 * DELETE /:terminalId — only ever allowed for a counter with no shift history.
 * Once a Z report exists against a terminal, that report must keep naming the
 * counter it happened on, so the route steers the caller to deactivation
 * instead of silently orphaning history.
 */
router.delete('/:terminalId', requireOperatorOnPairedDevice, requireRole('manager'), async (req, res) => {
  const storeId = singleStoreId(req, res)
  if (!storeId) return
  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.terminals.findFirst({
    where: { id: req.params.terminalId, store_id: storeId },
  })
  if (!existing) {
    return res.status(404).json({ error: 'Counter not found' })
  }

  const shifts = await client.shifts.findMany({
    where: { terminal_id: existing.id },
    select: { id: true },
  })
  if (shifts.length > 0) {
    return res.status(409).json({
      error: 'This counter has shift history and cannot be deleted. Turn it off instead — its past Z reports stay intact.',
    })
  }

  await client.terminals.delete({ where: { id: existing.id } })
  return res.json({ deleted: true })
})

export default router
