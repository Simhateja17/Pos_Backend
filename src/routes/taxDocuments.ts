import { Router } from 'express'
import { z } from 'zod'
import { activeStoreId, storeScopeWhere } from '../middleware/storeContext'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { CreateTaxInvoiceSchema, TaxDocumentListQuerySchema } from '../contracts/schemas/taxDocument'
import { ensureTaxInvoice, readTaxDocument, toTaxDocumentJson } from '../services/taxDocuments'

const router = Router()
const uuidSchema = z.string().uuid()

function actorId(req: import('express').Request): string | null {
  return req.actingStaff?.id ?? null
}

function summary(row: any) {
  const full = toTaxDocumentJson(row, [])
  const { lines: _lines, ...result } = full
  return result
}

async function accessibleSale(req: import('express').Request, saleId: string) {
  const client = forTenant(req.user!.tenantId) as any
  return client.sales.findFirst({ where: { id: saleId, ...storeScopeWhere(req) } })
}

/** List immutable tax-document snapshots for the active store/business scope. */
router.get('/', async (req, res) => {
  const parsed = TaxDocumentListQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tax document query' })

  const client = forTenant(req.user!.tenantId) as any
  const where: Record<string, unknown> = { ...storeScopeWhere(req) }
  if (parsed.data.documentType) where.document_type = parsed.data.documentType
  if (parsed.data.customerId) where.customer_id = parsed.data.customerId
  if (parsed.data.documentNumber) where.document_number = parsed.data.documentNumber
  if (parsed.data.from || parsed.data.to || parsed.data.cursor) {
    where.document_date = {
      ...(parsed.data.from ? { gte: new Date(parsed.data.from) } : {}),
      ...(parsed.data.to ? { lte: new Date(parsed.data.to) } : {}),
      ...(parsed.data.cursor ? { lt: new Date(parsed.data.cursor) } : {}),
    }
  }

  const [rows, total] = await Promise.all([
    client.tax_documents.findMany({ where, orderBy: { document_date: 'desc' }, take: parsed.data.limit + 1 }),
    client.tax_documents.count({ where }),
  ])
  const hasMore = rows.length > parsed.data.limit
  const page = rows.slice(0, parsed.data.limit)
  return res.json({
    items: page.map(summary),
    total,
    nextCursor: hasMore ? page[page.length - 1].document_date.toISOString() : null,
  })
})

/** Explicit idempotent invoice creation boundary for completed sales. */
router.post('/invoices', async (req, res) => {
  const parsed = CreateTaxInvoiceSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid invoice request' })

  const sale = await accessibleSale(req, parsed.data.saleId)
  if (!sale) return res.status(404).json({ error: 'Sale not found' })

  try {
    const document = await forTenantTransaction(req.user!.tenantId, (tx) =>
      ensureTaxInvoice(tx, {
        tenantId: req.user!.tenantId,
        saleId: parsed.data.saleId,
        createdBy: actorId(req),
      }),
    )
    if (!document) return res.status(404).json({ error: 'Sale not found' })
    return res.status(201).json(document)
  } catch {
    return res.status(500).json({ error: 'Could not create tax invoice' })
  }
})

/** Lazy creation is safe because ensureTaxInvoice locks the sale row. */
router.get('/invoices/sale/:saleId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.saleId).success) return res.status(400).json({ error: 'Invalid saleId' })
  const sale = await accessibleSale(req, req.params.saleId)
  if (!sale) return res.status(404).json({ error: 'Sale not found' })

  try {
    const document = await forTenantTransaction(req.user!.tenantId, (tx) =>
      ensureTaxInvoice(tx, {
        tenantId: req.user!.tenantId,
        saleId: req.params.saleId,
        createdBy: actorId(req),
      }),
    )
    if (!document) return res.status(404).json({ error: 'Sale not found' })
    return res.json(document)
  } catch {
    return res.status(500).json({ error: 'Could not resolve tax invoice' })
  }
})

router.get('/invoices/:invoiceId/credit-notes', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.invoiceId).success) return res.status(400).json({ error: 'Invalid invoiceId' })
  const client = forTenant(req.user!.tenantId) as any
  const invoice = await client.tax_documents.findFirst({
    where: { id: req.params.invoiceId, document_type: 'tax_invoice', ...storeScopeWhere(req) },
  })
  if (!invoice) return res.status(404).json({ error: 'Tax invoice not found' })
  const rows = await client.tax_documents.findMany({
    where: { original_document_id: invoice.id, document_type: 'credit_note' },
    orderBy: { document_date: 'desc' },
  })
  return res.json(rows.map(summary))
})

router.get('/:documentId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.documentId).success) return res.status(400).json({ error: 'Invalid documentId' })
  const client = forTenant(req.user!.tenantId) as any
  const row = await client.tax_documents.findFirst({
    where: { id: req.params.documentId, ...storeScopeWhere(req) },
  })
  if (!row) return res.status(404).json({ error: 'Tax document not found' })

  const document = await forTenantTransaction(req.user!.tenantId, (tx) =>
    readTaxDocument(tx, req.user!.tenantId, req.params.documentId),
  )
  return document ? res.json(document) : res.status(404).json({ error: 'Tax document not found' })
})

export default router
