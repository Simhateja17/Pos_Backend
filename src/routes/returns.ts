import { activeStoreId } from '../middleware/storeContext'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { CreateReturnSchema } from '../contracts/schemas/return'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { findPairedTerminal } from '../lib/counterDevice'
import { createCreditNoteForReturn, ensureTaxInvoice } from '../services/taxDocuments'

const router = Router()

const ZERO = new Prisma.Decimal(0)

async function resolveActingStaffId(client: any, req: import('express').Request): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  const staff = await client.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } })
  return staff?.id ?? null
}

/**
 * POST / — process a return/refund against a prior sale (CHECK-07, D-09
 * through D-12). Mirrors sales.ts's forTenantTransaction dispatch pattern:
 * every early-exit response path is returned as a { status, body } object
 * from inside the transaction callback, and the outer handler dispatches
 * via a single switch so res is only ever called once, while keeping every
 * early exit genuinely inside the transaction (no write before the check).
 */
router.post('/', async (req, res) => {
  const parsed = CreateReturnSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() })
  }

  const tenantId = req.user!.tenantId
  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Choose a store before processing a return.' })
  }

  try {
    const pairedTerminal = await findPairedTerminal(forTenant(tenantId) as any, req)
    const actingRole = req.actingStaff?.role ?? req.user!.role
    if (actingRole === 'cashier' && !pairedTerminal) {
      return res.status(409).json({ error: 'This device is not paired to a counter.' })
    }

    const result = await forTenantTransaction(tenantId, async (tx) => {
      // T-03-14 / CASH-02 / D-13/D-15: shift lookup + closed-shift guard MUST
      // happen before any sale/line lookup or write, mirroring the identical
      // guard in POST /sales (03-03).
      const shift = await tx.shifts.findFirst({ where: { id: parsed.data.shiftId, store_id: storeId } })
      if (!shift) {
        return { status: 404, body: { error: 'Shift not found' } }
      }
      if (shift.closed_at !== null) {
        return {
          status: 409,
          body: { error: 'This shift has already been closed and cannot accept new returns.' },
        }
      }
      if (pairedTerminal && shift.terminal_id !== pairedTerminal.id) {
        return { status: 409, body: { error: 'This return belongs to a different counter.' } }
      }

      // CR-01 tenant-scoped lookup — never a bare/cross-tenant lookup.
      const sale = await tx.sales.findFirst({ where: { id: parsed.data.saleId, store_id: storeId } })
      if (!sale) {
        return { status: 404, body: { error: 'Sale not found' } }
      }

      // Serialize retries for the same sale before checking the idempotency
      // record. Without this lock, two concurrent requests could both pass the
      // check and append duplicate stock/refund rows before one of them hit the
      // credit-note unique index.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM public.sales
        WHERE id = ${sale.id}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE
      `

      // A retried return must be a read of the already committed result. This
      // check happens before stock/payment writes and is backed by the partial
      // unique index on tax_documents.return_reference_id.
      const existingCreditNote = await tx.tax_documents.findFirst({
        where: {
          tenant_id: tenantId,
          document_type: 'credit_note',
          return_reference_id: parsed.data.returnReferenceId,
        },
      })
      if (existingCreditNote) {
        if (existingCreditNote.sale_id !== sale.id) {
          return { status: 409, body: { error: 'Return reference has already been used for another sale.' } }
        }
        return {
          status: 200,
          body: {
            saleId: existingCreditNote.sale_id,
            returnReferenceId: parsed.data.returnReferenceId,
            refundTotal: existingCreditNote.grand_total.toString(),
            creditNoteId: existingCreditNote.id,
            creditNoteNumber: existingCreditNote.document_number,
            idempotent: true,
          },
        }
      }

      // T-03-10: each line must actually belong to the claimed sale, and
      // T-03-11: over-return (returning more than remains returnable) is
      // rejected before any write.
      const refundLines: { saleLineItem: any; quantity: number; refundAmount: Prisma.Decimal }[] = []
      for (const line of parsed.data.lines) {
        const saleLineItem = await tx.sale_line_items.findFirst({
          where: { id: line.saleLineItemId, sale_id: sale.id },
        })
        if (!saleLineItem) {
          return { status: 404, body: { error: `Sale line item ${line.saleLineItemId} not found on this sale` } }
        }

        const priorReturns = await tx.stock_movements.findMany({
          where: { movement_type: 'return', reference_id: sale.id, variant_id: saleLineItem.variant_id },
        })
        // quantity_delta is a Prisma Decimal since 0031; `sum + m.quantity_delta`
        // would concatenate strings, silently inflating the returned total.
        const alreadyReturned = priorReturns.reduce((sum: number, m: any) => sum + Number(m.quantity_delta), 0)
        const remainingReturnable = Number(saleLineItem.quantity) - alreadyReturned
        if (line.quantity > remainingReturnable) {
          return {
            status: 400,
            body: {
              error: `Cannot return ${line.quantity} of line ${line.saleLineItemId}; only ${remainingReturnable} remain returnable.`,
            },
          }
        }

        const refundAmount = saleLineItem.line_total
          .dividedBy(Number(saleLineItem.quantity))
          .times(line.quantity)

        refundLines.push({ saleLineItem, quantity: line.quantity, refundAmount })
      }

      // Existing sale_line_items store the pre-tax line amount. A GST credit
      // note must reverse the tax snapshot as well, so use the immutable
      // invoice line total for the refund amount. Tax-zero legacy sales keep
      // exactly the old amount.
      const invoice = await ensureTaxInvoice(tx, {
        tenantId,
        saleId: sale.id,
        createdBy: await resolveActingStaffId(tx, req),
      })
      if (!invoice) return { status: 404, body: { error: 'Tax invoice not found' } }
      const invoiceLineBySaleLine = new Map(
        invoice.lines
          .filter((line) => !!line.saleLineItemId)
          .map((line) => [line.saleLineItemId!, line]),
      )
      for (const refundLine of refundLines) {
        const invoiceLine = invoiceLineBySaleLine.get(refundLine.saleLineItem.id)
        if (!invoiceLine) return { status: 409, body: { error: 'Tax invoice line snapshot is incomplete' } }
        refundLine.refundAmount = new Prisma.Decimal(invoiceLine.lineTotal)
          .dividedBy(new Prisma.Decimal(invoiceLine.quantity))
          .times(refundLine.quantity)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      }

      const expectedRefundTotal = refundLines.reduce((sum, l) => sum.plus(l.refundAmount), ZERO)
      const refundPaymentSum = parsed.data.refundPayments.reduce(
        (sum, p) => sum.plus(new Prisma.Decimal(p.amount)),
        ZERO,
      )
      if (!refundPaymentSum.equals(expectedRefundTotal)) {
        return {
          status: 400,
          body: {
            error: `Refund payments must add up to the exact refund total (${expectedRefundTotal.toString()}). Currently ${refundPaymentSum.toString()}.`,
          },
        }
      }

      // D-10: the refund must go back to whichever method(s) actually paid
      // for the original sale — never a method that was never used, and
      // never a store-credit path. This is a data-integrity check, applies
      // regardless of the acting staff member's role (no manager-approval
      // carve-out, unlike D-05's discount gate).
      const originalPayments = await tx.payments.findMany({ where: { sale_id: sale.id, direction: 'payment' } })
      const originalPaymentMethods = new Set(originalPayments.map((p: any) => p.method))
      for (const entry of parsed.data.refundPayments) {
        if (!originalPaymentMethods.has(entry.method)) {
          return {
            status: 400,
            body: {
              error: `Refund method '${entry.method}' was not used on the original sale. This sale was paid via: ${[...originalPaymentMethods].join(', ')}.`,
            },
          }
        }
      }

      const createdBy = await resolveActingStaffId(tx, req)

      const createdMovements: any[] = []
      for (const refundLine of refundLines) {
        const movement = await tx.stock_movements.create({
          data: {
            tenant_id: tenantId,
            // Returns are store-scoped: the lookup and write both belong to
            // the shop that made the sale, preventing a bill from another
            // shop from crediting stock or cash to the wrong location.
            store_id: storeId,
            variant_id: refundLine.saleLineItem.variant_id,
            movement_type: 'return',
            quantity_delta: refundLine.quantity,
            reference_id: sale.id,
            // One append-only return movement retains the reason and the
            // counter/shift that processed it. Together with created_by and
            // created_at this is the cashier return audit trail.
            reason_note: `${parsed.data.reason} [shift:${shift.id}; counter:${shift.terminal_id ?? 'unpaired'}]`,
            created_by: createdBy,
          },
        })
        createdMovements.push(movement)
      }

      const createdPayments: any[] = []
      for (const entry of parsed.data.refundPayments) {
        const payment = await tx.payments.create({
          data: {
            tenant_id: tenantId,
            sale_id: sale.id,
            method: entry.method,
            direction: 'refund',
            amount: entry.amount,
            reference_code: entry.referenceCode ?? null,
            created_by: createdBy,
          },
        })
        createdPayments.push(payment)
      }

      const creditNoteResult = await createCreditNoteForReturn(tx, {
        tenantId,
        saleId: sale.id,
        returnReferenceId: parsed.data.returnReferenceId,
        returnedLines: refundLines.map((line) => ({
          saleLineItemId: line.saleLineItem.id,
          quantity: new Prisma.Decimal(line.quantity),
        })),
        refundPayments: createdPayments.map((payment) => ({
          method: String(payment.method),
          direction: String(payment.direction),
          amount: new Prisma.Decimal(payment.amount).toString(),
          referenceCode: payment.reference_code ?? null,
        })),
        createdBy,
      })
      if (!creditNoteResult.document) return { status: 500, body: { error: 'Could not create credit note' } }

      return {
        status: 201,
        body: {
          saleId: sale.id,
          returnReferenceId: parsed.data.returnReferenceId,
          refundedLines: refundLines.map((l) => ({
            saleLineItemId: l.saleLineItem.id,
            quantity: l.quantity,
            refundAmount: l.refundAmount.toString(),
          })),
          refundTotal: expectedRefundTotal.toString(),
          creditNoteId: creditNoteResult.document.id,
          creditNoteNumber: creditNoteResult.document.documentNumber,
          idempotent: false,
        },
      }
    })

    switch (result.status) {
      case 404:
        return res.status(404).json(result.body)
      case 409:
        return res.status(409).json(result.body)
      case 400:
        return res.status(400).json(result.body)
      case 200:
        return res.status(200).json(result.body)
      case 500:
        return res.status(500).json(result.body)
      default:
        return res.status(201).json(result.body)
    }
  } catch (err: any) {
    // Never leak raw Prisma/Postgres errors, same convention as sales.ts.
    return res.status(500).json({ error: 'Could not process return' })
  }
})

export default router
