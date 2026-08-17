import { activeStoreId, storeScopeWhere } from '../middleware/storeContext'
import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { OpenShiftSchema, CloseShiftSchema } from '../contracts/schemas/shift'
import { forTenant } from '../db/tenantClient'
import { findPairedTerminal } from '../lib/counterDevice'

const router = Router()

const ZERO = new Prisma.Decimal(0)

function effectiveRole(req: import('express').Request) {
  return req.actingStaff?.role ?? req.user!.role
}

async function cashierCanAccessShift(client: any, req: import('express').Request, shift: any) {
  if (effectiveRole(req) !== 'cashier') return true
  const terminal = await findPairedTerminal(client, req)
  return Boolean(terminal && shift.terminal_id === terminal.id)
}

// Copied verbatim from stockMovements.ts (per plan interfaces note) — resolves
// the acting staff member's id for `staff_id`/`created_by` attribution.
async function resolveActingStaffId(client: any, req: import('express').Request): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  const staff = await client.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } })
  return staff?.id ?? null
}

function toShiftJson(row: any) {
  return {
    id: row.id,
    staffId: row.staff_id,
    terminalId: row.terminal_id ?? null,
    startingCash: row.starting_cash.toString(),
    openedAt: row.opened_at.toISOString(),
    countedCash: row.counted_cash ? row.counted_cash.toString() : null,
    variance: row.variance ? row.variance.toString() : null,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  }
}

function sumBy<T>(rows: T[], fn: (row: T) => Prisma.Decimal): Prisma.Decimal {
  return rows.reduce((acc, row) => acc.plus(fn(row)), ZERO)
}

async function resolveRequestTerminal(client: any, req: import('express').Request, requestedId?: string) {
  const paired = await findPairedTerminal(client, req)
  if (paired) {
    const scope = storeScopeWhere(req)
    if (scope.store_id && paired.store_id !== scope.store_id) {
      return { terminal: null, error: `This device is paired to ${paired.name} in another store.` }
    }
    if (requestedId && requestedId !== paired.id) {
      return { terminal: null, error: `This device is paired to ${paired.name}.` }
    }
    return { terminal: paired, error: null }
  }

  // A cashier PIN session is only valid on a paired counter. Owners/managers
  // may still use the explicit id during first-time setup, before pairing a
  // browser from Settings.
  if (effectiveRole(req) === 'cashier' && !requestedId) {
    return { terminal: null, error: 'Pair this device to a counter before opening a shift.' }
  }
  if (!requestedId) return { terminal: null, error: 'Pair this device to a counter before opening a shift.' }
  return {
    terminal: await client.terminals.findFirst({ where: { id: requestedId, ...storeScopeWhere(req) } }),
    error: null,
  }
}

function toTerminalContextJson(row: any, hasOpenShift: boolean) {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    hasOpenShift,
    createdAt: row.created_at.toISOString(),
    cashMode: row.cash_mode === 'none' ? 'none' : 'cash',
    isPaired: Boolean(row.device_token_hash),
    isCurrentDevice: true,
    deviceLastSeenAt: row.device_last_seen_at ? row.device_last_seen_at.toISOString() : null,
  }
}

/**
 * computeXReport — the single aggregation function shared by BOTH the
 * GET /:shiftId/x-report handler and the POST /:shiftId/close handler (D-15),
 * so the two reports can never numerically disagree (RESEARCH.md Pitfall 2's
 * "persist, don't re-derive" discipline extended to shift reconciliation).
 * This is a PURE READ — it performs no writes and can be called any number of
 * times without mutating the shift.
 */
export async function computeXReport(client: any, shift: any) {
  const sales = await client.sales.findMany({ where: { shift_id: shift.id } })
  const saleIds = sales.map((s: any) => s.id)
  const payments = saleIds.length > 0
    ? await client.payments.findMany({ where: { sale_id: { in: saleIds } } })
    : []

  const cashSalesTotal = sumBy(payments, (p: any) =>
    p.direction === 'payment' && p.method === 'cash' ? new Prisma.Decimal(p.amount) : ZERO,
  )
  const cardSalesTotal = sumBy(payments, (p: any) =>
    p.direction === 'payment' && p.method === 'card' ? new Prisma.Decimal(p.amount) : ZERO,
  )
  const upiSalesTotal = sumBy(payments, (p: any) =>
    p.direction === 'payment' && p.method === 'upi' ? new Prisma.Decimal(p.amount) : ZERO,
  )
  const checkSalesTotal = sumBy(payments, (p: any) =>
    p.direction === 'payment' && p.method === 'check' ? new Prisma.Decimal(p.amount) : ZERO,
  )
  // Only cash refunds affect the physical drawer.
  const refundsTotal = sumBy(payments, (p: any) =>
    p.direction === 'refund' && p.method === 'cash' ? new Prisma.Decimal(p.amount).abs() : ZERO,
  )

  const expectedCash = new Prisma.Decimal(shift.starting_cash).plus(cashSalesTotal).minus(refundsTotal)

  return {
    shiftId: shift.id,
    expectedCash: expectedCash.toString(),
    cashSalesTotal: cashSalesTotal.toString(),
    cardSalesTotal: cardSalesTotal.toString(),
    upiSalesTotal: upiSalesTotal.toString(),
    checkSalesTotal: checkSalesTotal.toString(),
    refundsTotal: refundsTotal.toString(),
    saleCount: sales.length,
    _expectedCashDecimal: expectedCash,
  }
}

/**
 * GET / — shift history for the tenant, newest first. Staff and terminal
 * names are resolved here so the client renders a list without joining two
 * more endpoints itself. Includes the currently-open shifts (closedAt null),
 * which is how a shared till knows what is already running on each counter.
 */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const storeScope = storeScopeWhere(req)

  let where: any = undefined
  if (effectiveRole(req) === 'cashier') {
    const terminal = await findPairedTerminal(client, req)
    if (!terminal) return res.status(409).json({ error: 'This device is not paired to a counter.' })
    where = { ...storeScope, terminal_id: terminal.id, closed_at: null }
  } else {
    where = storeScope
  }

  const shifts = await client.shifts.findMany({ where, orderBy: [{ opened_at: 'desc' }], take: 100 })
  const staff = await client.staff_members.findMany({ where: storeScope, select: { id: true, name: true } })
  const terminals = await client.terminals.findMany({ where: storeScope, select: { id: true, name: true } })

  const staffNames = new Map(staff.map((row: any) => [row.id, row.name]))
  const terminalNames = new Map(terminals.map((row: any) => [row.id, row.name]))

  return res.json(
    shifts.map((row: any) => ({
      ...toShiftJson(row),
      staffName: staffNames.get(row.staff_id) ?? null,
      terminalName: row.terminal_id ? terminalNames.get(row.terminal_id) ?? null : null,
    })),
  )
})

/** The one shift that belongs to this paired counter, irrespective of which
 * cashier most recently entered their PIN. */
router.get('/current', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const { terminal } = await resolveRequestTerminal(client, req)
  if (!terminal) return res.json({ terminal: null, shift: null })

  const shift = await client.shifts.findFirst({
    where: { ...storeScopeWhere(req), terminal_id: terminal.id, closed_at: null },
  })
  const staff = shift
    ? await client.staff_members.findFirst({ where: { id: shift.staff_id, ...storeScopeWhere(req) }, select: { name: true } })
    : null
  return res.json({
    terminal: toTerminalContextJson(terminal, Boolean(shift)),
    shift: shift ? { ...toShiftJson(shift), staffName: staff?.name ?? null } : null,
  })
})

/**
 * POST / — open a shift with a starting cash count (D-14). The shift row is
 * durable (survives terminal reload), not client-only state (D-13).
 *
 * Since 0034 a shift belongs to a named counter, and one counter is one
 * physical drawer: opening a second shift on a till someone else is already
 * running is rejected. The DB carries a partial unique index for the same
 * rule, because two simultaneous requests would both pass the check below.
 */
router.post('/', async (req, res) => {
  const parsed = OpenShiftSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Pick which counter this drawer is on.' })
  }

  const client = forTenant(req.user!.tenantId) as any
  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Choose a store before opening a shift.' })
  }
  const staffId = await resolveActingStaffId(client, req)
  if (!staffId) {
    return res.status(400).json({ error: 'Could not resolve the acting staff member' })
  }

  const resolved = await resolveRequestTerminal(client, req, parsed.data.terminalId)
  if (resolved.error) return res.status(409).json({ error: resolved.error })
  const terminal = resolved.terminal
  if (!terminal) {
    return res.status(404).json({ error: 'Counter not found' })
  }
  if (!terminal.is_active) {
    return res.status(409).json({ error: 'That counter is turned off. Pick another, or turn it back on in Settings.' })
  }

  const openOnTerminal = await client.shifts.findFirst({
    where: { store_id: storeId, terminal_id: terminal.id, closed_at: null },
  })
  if (openOnTerminal) {
    const holder = await client.staff_members.findFirst({
      where: { id: openOnTerminal.staff_id, store_id: storeId },
      select: { name: true },
    })
    return res.status(409).json({
      code: 'SHIFT_ALREADY_OPEN',
      error: holder?.name
        ? `${terminal.name} already has a shift open, run by ${holder.name}. Close it before opening another.`
        : `${terminal.name} already has a shift open. Close it before opening another.`,
      shift: toShiftJson(openOnTerminal),
    })
  }

  const startingCash = terminal.cash_mode === 'none' ? '0.00' : parsed.data.startingCash
  if (terminal.cash_mode === 'cash' && !startingCash) {
    return res.status(400).json({ error: 'Enter the opening cash in this counter.' })
  }

  try {
    const shift = await client.shifts.create({
      data: {
        tenant_id: req.user!.tenantId,
        store_id: storeId,
        staff_id: staffId,
        terminal_id: terminal.id,
        starting_cash: startingCash,
      },
    })
    if (req.actingStaff?.sessionId) {
      await client.staff_sessions.updateMany({
        where: { id: req.actingStaff.sessionId, logged_out_at: null },
        data: { shift_id: shift.id, last_seen_at: new Date() },
      })
    }
    return res.status(201).json(toShiftJson(shift))
  } catch (err: any) {
    // The partial unique index caught a race the check above could not.
    if (err.code === 'P2002') {
      return res.status(409).json({ error: `${terminal.name} already has a shift open. Close it before opening another.` })
    }
    throw err
  }
})

/**
 * GET /:shiftId/x-report — D-15: a live, non-resetting snapshot. Callable any
 * number of times; never writes to the shifts row.
 */
router.get('/:shiftId/x-report', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.shiftId).success) {
    return res.status(400).json({ error: 'Invalid shiftId' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const shift = await client.shifts.findFirst({
    where: { id: req.params.shiftId, ...storeScopeWhere(req) },
  })
  if (!shift) {
    return res.status(404).json({ error: 'Shift not found' })
  }
  if (!(await cashierCanAccessShift(client, req, shift))) {
    return res.status(403).json({ error: 'This shift belongs to a different counter.' })
  }

  const { _expectedCashDecimal, ...report } = await computeXReport(client, shift)
  return res.json(report)
})

/**
 * POST /:shiftId/close — D-15/D-16: the Z report. The closing cashier enters
 * counted cash; the server recomputes expectedCash via the SAME
 * computeXReport() helper used by the X report (so the two numbers can never
 * disagree), computes variance = counted - expected, and locks the shift.
 * No manager+ sign-off required (D-16). Rejects a second close attempt (409).
 */
router.post('/:shiftId/close', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.shiftId).success) {
    return res.status(400).json({ error: 'Invalid shiftId' })
  }

  const parsed = CloseShiftSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Choose a store before closing a shift.' })
  }
  const shift = await client.shifts.findFirst({
    where: { id: req.params.shiftId, store_id: storeId },
  })
  if (!shift) {
    return res.status(404).json({ error: 'Shift not found' })
  }
  if (!(await cashierCanAccessShift(client, req, shift))) {
    return res.status(403).json({ error: 'This shift belongs to a different counter.' })
  }
  if (shift.closed_at !== null) {
    return res.status(409).json({ error: 'This shift has already been closed.' })
  }

  const report = await computeXReport(client, shift)
  const countedCash = new Prisma.Decimal(parsed.data.countedCash)
  const variance = countedCash.minus(report._expectedCashDecimal)

  const updated = await client.shifts.update({
    where: { id: req.params.shiftId, store_id: storeId },
    data: {
      counted_cash: countedCash.toString(),
      variance: variance.toString(),
      closed_at: new Date(),
    },
  })

  const { _expectedCashDecimal, ...reportJson } = report
  return res.status(200).json({
    ...reportJson,
    countedCash: updated.counted_cash.toString(),
    variance: updated.variance.toString(),
    closedAt: updated.closed_at.toISOString(),
  })
})

export default router
