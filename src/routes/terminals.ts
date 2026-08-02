import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import { CreateTerminalSchema, UpdateTerminalSchema } from '../contracts/schemas/terminal'

const router = Router()

function toTerminalJson(row: any, hasOpenShift: boolean) {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    hasOpenShift,
    createdAt: row.created_at.toISOString(),
  }
}

async function listWithOpenShifts(client: any) {
  const terminals = await client.terminals.findMany({ orderBy: [{ name: 'asc' }] })
  const openShifts = await client.shifts.findMany({
    where: { closed_at: null },
    select: { terminal_id: true },
  })
  const busy = new Set(openShifts.map((row: any) => row.terminal_id).filter(Boolean))
  return terminals.map((row: any) => toTerminalJson(row, busy.has(row.id)))
}

/**
 * GET / — the tenant's till list. Read is open to every role: a cashier must
 * be able to see the terminals in order to pick one when opening a shift.
 * Mutations below are manager+ (owner/manager configure the store's counters).
 */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  return res.json(await listWithOpenShifts(client))
})

router.post('/', requireRole('manager'), async (req, res) => {
  const parsed = CreateTerminalSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Enter a name for this counter.' })
  }

  const client = forTenant(req.user!.tenantId) as any
  try {
    const created = await client.terminals.create({
      data: { tenant_id: req.user!.tenantId, name: parsed.data.name },
    })
    return res.status(201).json(toTerminalJson(created, false))
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You already have a counter with that name' })
    }
    return res.status(500).json({ error: 'Could not create that counter' })
  }
})

router.patch('/:terminalId', requireRole('manager'), async (req, res) => {
  const parsed = UpdateTerminalSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  // RLS-scoped read first so another tenant's id cannot be renamed by guessing.
  const existing = await client.terminals.findFirst({ where: { id: req.params.terminalId } })
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
      },
    })
    const openShift = await client.shifts.findFirst({
      where: { terminal_id: updated.id, closed_at: null },
      select: { id: true },
    })
    return res.json(toTerminalJson(updated, Boolean(openShift)))
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
router.delete('/:terminalId', requireRole('manager'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.terminals.findFirst({ where: { id: req.params.terminalId } })
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
