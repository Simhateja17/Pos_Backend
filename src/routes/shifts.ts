import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { OpenShiftSchema, CloseShiftSchema } from '../contracts/schemas/shift'
import { forTenant } from '../db/tenantClient'

const router = Router()

const ZERO = new Prisma.Decimal(0)

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

/**
 * computeXReport — the single aggregation function shared by BOTH the
 * GET /:shiftId/x-report handler and the POST /:shiftId/close handler (D-15),
 * so the two reports can never numerically disagree (RESEARCH.md Pitfall 2's
 * "persist, don't re-derive" discipline extended to shift reconciliation).
 * This is a PURE READ — it performs no writes and can be called any number of
 * times without mutating the shift.
 */
async function computeXReport(client: any, shift: any) {
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
    checkSalesTotal: checkSalesTotal.toString(),
    refundsTotal: refundsTotal.toString(),
    saleCount: sales.length,
    _expectedCashDecimal: expectedCash,
  }
}

/**
 * POST / — open a shift with a starting cash count (D-14). The shift row is
 * durable (survives terminal reload), not client-only state (D-13).
 */
router.post('/', async (req, res) => {
  const parsed = OpenShiftSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const staffId = await resolveActingStaffId(client, req)
  if (!staffId) {
    return res.status(400).json({ error: 'Could not resolve the acting staff member' })
  }

  const shift = await client.shifts.create({
    data: {
      tenant_id: req.user!.tenantId,
      staff_id: staffId,
      starting_cash: parsed.data.startingCash,
    },
  })

  return res.status(201).json(toShiftJson(shift))
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
  const shift = await client.shifts.findFirst({ where: { id: req.params.shiftId } })
  if (!shift) {
    return res.status(404).json({ error: 'Shift not found' })
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
  const shift = await client.shifts.findFirst({ where: { id: req.params.shiftId } })
  if (!shift) {
    return res.status(404).json({ error: 'Shift not found' })
  }
  if (shift.closed_at !== null) {
    return res.status(409).json({ error: 'This shift has already been closed.' })
  }

  const report = await computeXReport(client, shift)
  const countedCash = new Prisma.Decimal(parsed.data.countedCash)
  const variance = countedCash.minus(report._expectedCashDecimal)

  const updated = await client.shifts.update({
    where: { id: req.params.shiftId },
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
