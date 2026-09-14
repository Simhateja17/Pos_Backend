import { activeStoreId } from '../middleware/storeContext'
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CreateReturnSchema, ReturnQuoteRequestSchema } from '../contracts/schemas/return'
import { allowsFractionalQuantity } from '../contracts/schemas/product'
import { unsupportedTenderMethods } from '../lib/tenderRules'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { findPairedTerminal } from '../lib/counterDevice'
import { createCreditNoteForReturn, lockTaxInvoiceSale, previewTaxInvoice } from '../services/taxDocuments'

const router = Router()

const ZERO = new Prisma.Decimal(0)

/** Read-only recovery authority for a payload-bound return reference. */
router.get('/recovery/:returnReferenceId', async (req, res) => {
  const reference = req.params.returnReferenceId
  if (!z.string().uuid().safeParse(reference).success) return res.status(400).json({ code: 'INVALID_OPERATION_ID', error: 'Invalid return recovery ID.' })
  let storeId: string
  try { storeId = activeStoreId(req) } catch { return res.status(400).json({ code: 'STORE_REQUIRED', error: 'Choose a store before checking a return.' }) }
  const client = forTenant(req.user!.tenantId) as any
  const staff = req.actingStaff?.id ?? (await client.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true, store_id: storeId }, select: { id: true } }))?.id
  if (!staff) return res.status(403).json({ code: 'OPERATOR_INVALID', error: 'The active operator is unavailable.' })
  const document = await client.tax_documents.findFirst({ where: { tenant_id: req.user!.tenantId, store_id: storeId, document_type: 'credit_note', return_reference_id: reference, created_by: staff } })
  if (!document) return res.status(404).json({ code: 'OPERATION_NOT_COMMITTED', error: 'No completed return uses this recovery ID.' })
  const lines = await client.tax_document_lines.findMany({
    where: { tenant_id: req.user!.tenantId, document_id: document.id },
    orderBy: { line_number: 'asc' },
  })
  const refundPayments = Array.isArray(document.payment_snapshot)
    ? document.payment_snapshot.map((payment: any) => ({
        method: String(payment.method),
        amount: String(payment.amount),
        referenceCode: payment.referenceCode ?? null,
      }))
    : []
  return res.json({
    saleId: document.sale_id,
    returnReferenceId: reference,
    refundedLines: lines.map((line: any) => ({
      saleLineItemId: line.sale_line_item_id,
      quantity: Number(line.quantity),
      refundAmount: line.line_total.toString(),
    })),
    refundTotal: document.grand_total.toString(),
    refundPayments,
    creditNoteId: document.id,
    creditNoteNumber: document.document_number,
    idempotent: true,
  })
})

/** Credit-note lines are the line-specific return ledger. Stock movements are
 * variant-scoped and cannot distinguish two sale lines for the same variant
 * that had different discounts or tax snapshots. */
async function returnedQuantitiesBySaleLine(
  tx: any,
  tenantId: string,
  saleId: string,
  saleLineItemIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  const result = new Map<string, Prisma.Decimal>()
  if (saleLineItemIds.length === 0) return result
  const creditNotes = await tx.tax_documents.findMany({
    where: { tenant_id: tenantId, sale_id: saleId, document_type: 'credit_note' },
    select: { id: true },
  })
  if (creditNotes.length === 0) return result
  const lines = await tx.tax_document_lines.findMany({
    where: {
      tenant_id: tenantId,
      document_id: { in: creditNotes.map((document: any) => document.id) },
      sale_line_item_id: { in: saleLineItemIds },
    },
    select: { sale_line_item_id: true, quantity: true },
  })
  for (const line of lines) {
    if (!line.sale_line_item_id) continue
    result.set(
      line.sale_line_item_id,
      (result.get(line.sale_line_item_id) ?? ZERO).plus(new Prisma.Decimal(line.quantity)),
    )
  }
  return result
}

/**
 * Read-only refund preview. A tax snapshot must already exist: calling
 * ensureTaxInvoice here would allocate a document number and violate the
 * quote's no-write contract. When a persisted tax invoice is absent (for
 * example, a legacy or International sale), the route uses the same pure
 * tax-source builder in memory; the action route will persist that snapshot
 * only after all return and payment checks pass.
 */
router.post('/quote', async (req, res) => {
  const parsed = ReturnQuoteRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ code: 'INVALID_REQUEST', message: 'Choose at least one return quantity.' })
  let storeId: string
  try { storeId = activeStoreId(req) } catch { return res.status(400).json({ code: 'STORE_REQUIRED', message: 'Choose a store before previewing a return.' }) }
  try {
    const result = await forTenantTransaction(req.user!.tenantId, async (tx) => {
      const sale = await tx.sales.findFirst({ where: { id: parsed.data.saleId, store_id: storeId } })
      if (!sale) return { status: 404, body: { code: 'SALE_NOT_FOUND', message: 'Sale not found.' } }
      if (sale.status !== 'completed') return { status: 409, body: { code: 'SALE_NOT_RETURNABLE', message: 'Only completed sales can be returned.' } }
      const invoice = await tx.tax_documents.findFirst({
        where: { tenant_id: req.user!.tenantId, sale_id: sale.id, document_type: 'tax_invoice' },
      })
      const invoicePreview = invoice ? null : await previewTaxInvoice(tx, req.user!.tenantId, sale.id)
      const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId }, select: { country: true } })
      const saleLines = await tx.sale_line_items.findMany({
        where: { sale_id: sale.id, tenant_id: req.user!.tenantId },
        include: { variants: { include: { products: { select: { name: true } } } } },
      })
      const invoiceLines = invoice
        ? await tx.tax_document_lines.findMany({ where: { document_id: invoice.id, tenant_id: req.user!.tenantId } })
        : invoicePreview!.lines.map((line) => ({
            sale_line_item_id: line.saleLineItemId,
            quantity: new Prisma.Decimal(line.quantity),
            line_total: new Prisma.Decimal(line.lineTotal),
          }))
      const invoiceBySaleLine = new Map<string, any>(invoiceLines.filter((line: any) => line.sale_line_item_id).map((line: any) => [line.sale_line_item_id, line] as [string, any]))
      const requestedIds = new Set<string>()
      const selectedLines: Array<{ request: (typeof parsed.data.lines)[number]; saleLine: any }> = []
      for (const line of parsed.data.lines) {
        if (requestedIds.has(line.saleLineItemId)) return { status: 400, body: { code: 'DUPLICATE_RETURN_LINE', message: 'Choose each sale line only once.' } }
        requestedIds.add(line.saleLineItemId)
        const saleLine = saleLines.find((candidate: any) => candidate.id === line.saleLineItemId)
        if (!saleLine) return { status: 404, body: { code: 'SALE_LINE_NOT_FOUND', message: 'A selected line is not on this sale.' } }
        if (!allowsFractionalQuantity(saleLine.variants?.unit_of_measure ?? 'piece') && !Number.isInteger(line.quantity)) {
          return { status: 400, body: { code: 'INVALID_QUANTITY', message: 'Return quantity must be a whole number for variants sold by piece.' } }
        }
        selectedLines.push({ request: line, saleLine })
      }
      const returnedByLine = await returnedQuantitiesBySaleLine(
        tx,
        req.user!.tenantId,
        sale.id,
        selectedLines.map(({ saleLine }) => saleLine.id),
      )
      const output: any[] = []
      for (const { request: line, saleLine } of selectedLines) {
        const remaining = new Prisma.Decimal(saleLine.quantity).minus(returnedByLine.get(saleLine.id) ?? ZERO)
        if (new Prisma.Decimal(line.quantity).greaterThan(remaining)) return { status: 400, body: { code: 'OVER_RETURN', message: `Only ${remaining.toString()} remain returnable for this line.` } }
        const invoiceLine = invoiceBySaleLine.get(saleLine.id)
        if (!invoiceLine) return { status: 409, body: { code: 'RETURN_PREVIEW_UNAVAILABLE', message: 'The tax snapshot is missing a selected line.' } }
        const refundAmount = new Prisma.Decimal(invoiceLine.line_total)
          .dividedBy(new Prisma.Decimal(invoiceLine.quantity))
          .times(line.quantity)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        output.push({
          saleLineItemId: saleLine.id,
          variantId: saleLine.variant_id,
          productName: saleLine.variants?.products?.name ?? null,
          requestedQuantity: line.quantity,
          remainingQuantity: remaining.toNumber(),
          refundAmount: refundAmount.toFixed(2),
        })
      }
      const payments = await tx.payments.findMany({ where: { sale_id: sale.id, tenant_id: req.user!.tenantId }, orderBy: { created_at: 'asc' } })
      const remainingByMethod = new Map<string, Prisma.Decimal>()
      for (const payment of payments) {
        const signed = new Prisma.Decimal(payment.amount).times(payment.direction === 'refund' ? -1 : 1)
        remainingByMethod.set(payment.method, (remainingByMethod.get(payment.method) ?? ZERO).plus(signed))
      }
      return {
        status: 200,
        body: {
          saleId: sale.id,
          storeId,
          currency: String(tenant?.country).toUpperCase() === 'IN' ? 'INR' : 'USD',
          refundTotal: output.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.refundAmount)), ZERO).toFixed(2),
          lines: output,
          originalPayments: [...remainingByMethod.entries()]
            .filter(([, amount]) => amount.greaterThan(ZERO))
            .map(([method, amount]) => ({ method, amount: amount.toFixed(2) })),
        },
      }
    })
    return res.status(result.status).json(result.body)
  } catch {
    return res.status(500).json({ code: 'RETURN_QUOTE_FAILED', message: 'Could not calculate the server refund preview.' })
  }
})

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
    const actingStaffId = await resolveActingStaffId(forTenant(tenantId) as any, req)
    if (!actingStaffId) return res.status(409).json({ code: 'OPERATOR_INVALID', error: 'The active operator is unavailable.' })
    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
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
      if (sale.status !== 'completed') {
        return { status: 409, body: { code: 'SALE_NOT_RETURNABLE', error: 'Only completed sales can be returned.' } }
      }
      const tenant = await tx.tenants.findFirst({ where: { id: tenantId }, select: { country: true } })
      if (!tenant) return { status: 404, body: { error: 'Tenant not found' } }

      // Serialize retries for the same sale before checking the idempotency
      // record. Without this lock, two concurrent requests could both pass the
      // check and append duplicate stock/refund rows before one of them hit the
      // credit-note unique index.
      // app_runtime intentionally cannot issue SELECT ... FOR UPDATE against
      // the append-only sales table. Use the tenant-checked SECURITY DEFINER
      // boundary created for this exact lock instead.
      const lockedSaleId = await lockTaxInvoiceSale(tx, tenantId, sale.id)
      if (!lockedSaleId) return { status: 404, body: { error: 'Sale not found' } }

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
        if (existingCreditNote.created_by !== actingStaffId) {
          return { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', error: 'This return reference belongs to a different operator.' } }
        }
        // Null is retained only for credit notes created before 0087. Every
        // new mobile return binds its reference to the exact immutable body.
        if (existingCreditNote.request_hash && existingCreditNote.request_hash !== requestHash) {
          return { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', error: 'This return reference was already used for different return data.' } }
        }
        return {
          status: 200,
          body: {
            saleId: existingCreditNote.sale_id,
            returnReferenceId: parsed.data.returnReferenceId,
            refundTotal: existingCreditNote.grand_total.toString(),
            refundPayments: Array.isArray(existingCreditNote.payment_snapshot)
              ? existingCreditNote.payment_snapshot.map((payment: any) => ({
                  method: String(payment.method),
                  amount: String(payment.amount),
                  referenceCode: payment.referenceCode ?? null,
                }))
              : [],
            creditNoteId: existingCreditNote.id,
            creditNoteNumber: existingCreditNote.document_number,
            idempotent: true,
          },
        }
      }

      // Use a persisted invoice when one exists. Legacy/International sales
      // may not have one yet, so build the same tax snapshot in memory. This
      // read-only fallback is important: rejected returns must not allocate a
      // document number just to discover their refund amount.
      const persistedInvoice = await tx.tax_documents.findFirst({
        where: { tenant_id: tenantId, sale_id: sale.id, document_type: 'tax_invoice' },
      })
      const invoicePreview = persistedInvoice ? null : await previewTaxInvoice(tx, tenantId, sale.id)
      const invoiceLines = persistedInvoice
        ? await tx.tax_document_lines.findMany({ where: { document_id: persistedInvoice.id, tenant_id: tenantId } })
        : invoicePreview!.lines.map((line) => ({
            sale_line_item_id: line.saleLineItemId,
            quantity: new Prisma.Decimal(line.quantity),
            line_total: new Prisma.Decimal(line.lineTotal),
          }))
      const invoiceLineBySaleLine = new Map<string, any>(
        invoiceLines
          .filter((line: any) => !!line.sale_line_item_id)
          .map((line: any) => [line.sale_line_item_id, line] as [string, any]),
      )

      // T-03-10: each line must actually belong to the claimed sale, and
      // T-03-11: over-return (returning more than remains returnable) is
      // rejected before any write.
      const refundLines: { saleLineItem: any; quantity: number; refundAmount: Prisma.Decimal }[] = []
      const requestedLineIds = new Set<string>()
      const selectedLines: Array<{ request: (typeof parsed.data.lines)[number]; saleLineItem: any }> = []
      for (const line of parsed.data.lines) {
        if (requestedLineIds.has(line.saleLineItemId)) {
          return { status: 400, body: { error: 'Choose each sale line only once.', code: 'DUPLICATE_RETURN_LINE' } }
        }
        requestedLineIds.add(line.saleLineItemId)
        const saleLineItem = await tx.sale_line_items.findFirst({
          where: { id: line.saleLineItemId, sale_id: sale.id },
          include: { variants: { select: { unit_of_measure: true } } },
        })
        if (!saleLineItem) {
          return { status: 404, body: { error: `Sale line item ${line.saleLineItemId} not found on this sale` } }
        }

        if (!allowsFractionalQuantity(saleLineItem.variants?.unit_of_measure ?? 'piece') && !Number.isInteger(line.quantity)) {
          return {
            status: 400,
            body: { error: 'Return quantity must be a whole number for variants sold by piece.', code: 'INVALID_QUANTITY' },
          }
        }

        selectedLines.push({ request: line, saleLineItem })
      }

      const returnedByLine = await returnedQuantitiesBySaleLine(
        tx,
        tenantId,
        sale.id,
        selectedLines.map(({ saleLineItem }) => saleLineItem.id),
      )
      for (const { request: line, saleLineItem } of selectedLines) {
        const remainingReturnable = new Prisma.Decimal(saleLineItem.quantity)
          .minus(returnedByLine.get(saleLineItem.id) ?? ZERO)
        if (new Prisma.Decimal(line.quantity).greaterThan(remainingReturnable)) {
          return {
            status: 400,
            body: {
              error: `Cannot return ${line.quantity} of line ${line.saleLineItemId}; only ${remainingReturnable.toString()} remain returnable.`,
            },
          }
        }

        const invoiceLine = invoiceLineBySaleLine.get(saleLineItem.id)
        if (!invoiceLine) return { status: 409, body: { error: 'Tax invoice line snapshot is incomplete' } }
        const refundAmount = new Prisma.Decimal(invoiceLine.line_total)
          .dividedBy(new Prisma.Decimal(invoiceLine.quantity))
          .times(line.quantity)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

        refundLines.push({ saleLineItem, quantity: line.quantity, refundAmount })
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

      if (expectedRefundTotal.greaterThan(ZERO) && parsed.data.refundPayments.some((payment) => new Prisma.Decimal(payment.amount).lessThanOrEqualTo(ZERO))) {
        return {
          status: 400,
          body: { error: 'Refund payment amounts must be greater than zero.', code: 'INVALID_PAYMENT_AMOUNT' },
        }
      }

      // D-10: the refund must go back to whichever method(s) actually paid
      // for the original sale — never a method that was never used, and
      // never a store-credit path. This is a data-integrity check, applies
      // regardless of the acting staff member's role (no manager-approval
      // carve-out, unlike D-05's discount gate).
      const originalPayments = await tx.payments.findMany({ where: { sale_id: sale.id, direction: 'payment' } })
      const unsupportedMethods = unsupportedTenderMethods(tenant.country, parsed.data.refundPayments.map((payment) => payment.method))
      if (unsupportedMethods.length > 0) {
        return {
          status: 400,
          body: { error: `Refund tender method(s) ${unsupportedMethods.join(', ')} are not available for this store's region.`, code: 'UNSUPPORTED_TENDER' },
        }
      }
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
      const priorRefundPayments = await tx.payments.findMany({ where: { sale_id: sale.id, direction: 'refund' } })
      const paidByMethod = new Map<string, Prisma.Decimal>()
      const refundedByMethod = new Map<string, Prisma.Decimal>()
      const requestedByMethod = new Map<string, Prisma.Decimal>()
      for (const payment of originalPayments) {
        paidByMethod.set(payment.method, (paidByMethod.get(payment.method) ?? ZERO).plus(new Prisma.Decimal(payment.amount)))
      }
      for (const payment of priorRefundPayments) {
        refundedByMethod.set(payment.method, (refundedByMethod.get(payment.method) ?? ZERO).plus(new Prisma.Decimal(payment.amount)))
      }
      for (const payment of parsed.data.refundPayments) {
        requestedByMethod.set(payment.method, (requestedByMethod.get(payment.method) ?? ZERO).plus(new Prisma.Decimal(payment.amount)))
      }
      for (const [method, requested] of requestedByMethod) {
        const remainingOnMethod = (paidByMethod.get(method) ?? ZERO).minus(refundedByMethod.get(method) ?? ZERO)
        if (requested.greaterThan(remainingOnMethod)) {
          return {
            status: 400,
            body: {
              code: 'REFUND_TENDER_EXCEEDS_PAYMENT',
              error: `Refund to '${method}' exceeds the amount still returnable to that original tender.`,
            },
          }
        }
      }

      const createdBy = actingStaffId
      const creditRefundTotal = parsed.data.refundPayments
        .filter((entry) => entry.method === 'credit')
        .reduce((sum, entry) => sum.plus(new Prisma.Decimal(entry.amount)), ZERO)
      if (creditRefundTotal.greaterThan(ZERO) && (!sale.customer_id || !createdBy)) {
        return {
          status: 409,
          body: {
            code: 'CREDIT_REFUND_UNAVAILABLE',
            error: 'Customer credit can only be refunded to the saved customer by an active operator.',
          },
        }
      }

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

      if (creditRefundTotal.greaterThan(ZERO)) {
        await tx.customer_credit_transactions.create({
          data: {
            tenant_id: tenantId,
            customer_id: sale.customer_id,
            store_id: storeId,
            type: 'credit_refund',
            amount: creditRefundTotal.toFixed(2),
            sale_id: sale.id,
            return_reference_id: parsed.data.returnReferenceId,
            recorded_by: createdBy,
            note: `Return ${parsed.data.returnReferenceId}`,
          },
        })
      }

      const creditNoteResult = await createCreditNoteForReturn(tx, {
        tenantId,
        saleId: sale.id,
        returnReferenceId: parsed.data.returnReferenceId,
        requestHash,
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
      // Returning an error object from an interactive transaction commits any
      // stock/refund writes made above. Throw so an impossible missing
      // document rolls the entire return back instead of reporting failure
      // after partially committing it.
      if (!creditNoteResult.document) throw new Error('Could not create credit note')

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
          refundPayments: createdPayments.map((payment) => ({
            method: String(payment.method),
            amount: new Prisma.Decimal(payment.amount).toString(),
            referenceCode: payment.reference_code ?? null,
          })),
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
    console.error('[returns:create] failed', err)
    return res.status(500).json({ error: 'Could not process return' })
  }
})

export default router
