import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { findPairedTerminal } from '../lib/counterDevice'
import {
  CustomerIdentityConflictError,
  CustomerValidationError,
  createCustomer,
  customerSearchWhere,
  searchCustomers,
  updateCustomer,
} from '../lib/customers'
import { activeStoreId, storeScopeWhere } from '../middleware/storeContext'
import { effectiveRole, requireRole, ROLE_RANK } from '../middleware/requireRole'
import {
  CreateRepaymentSchema,
} from '../contracts/schemas/customerCredit'
import {
  creditLimitString,
  getCustomerCreditTotalsForCustomer,
  isIndiaTenant,
  lockCustomerForCredit,
  moneyString,
  resolveCreditRecorder,
} from '../lib/customerCredit'
import {
  CreateCustomerInputSchema,
  CustomerListQuerySchema,
  CustomerPurchaseListQuerySchema,
  UpdateCustomerInputSchema,
} from '../contracts/schemas/customer'

const router = Router()
const customerIdSchema = z.string().uuid()

function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString()
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toCustomerJson(row: any) {
  const billingName = row.billing_name ?? row.name ?? null
  return {
    id: row.id,
    // `name` remains in the response for checkout and older generated clients;
    // the India profile uses billingName as its canonical display field.
    name: row.name ?? billingName,
    billingName,
    phone: row.phone ?? null,
    email: row.email ?? null,
    gstin: row.gstin ?? null,
    addressLine1: row.address_line1 ?? null,
    addressLine2: row.address_line2 ?? null,
    city: row.city ?? null,
    stateCode: row.state_code ?? null,
    postalCode: row.postal_code ?? null,
    country: row.country ?? 'IN',
    notes: row.notes ?? null,
    creditLimit: creditLimitString(row.credit_limit),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  }
}

function toCreditTransactionJson(row: any, storeById: Map<string, { id: string; name: string }>) {
  return {
    id: row.id,
    customerId: row.customer_id,
    storeId: row.store_id,
    storeName: storeById.get(row.store_id)?.name ?? null,
    type: row.type,
    amount: moneyString(row.amount),
    saleId: row.sale_id ?? null,
    recordedBy: row.recorded_by,
    note: row.note ?? null,
    createdAt: iso(row.created_at),
  }
}

function invalidCustomerId(res: any) {
  return res.status(400).json({ error: 'Invalid customerId' })
}

function writeErrorResponse(error: unknown, res: any) {
  if (error instanceof CustomerValidationError) {
    return res.status(400).json({ error: error.message, ...(error.field ? { field: error.field } : {}) })
  }
  if (error instanceof CustomerIdentityConflictError) {
    return res.status(409).json({ error: error.message, code: error.code })
  }
  // Prisma is deliberately kept behind `any` in this module until the
  // integrator refreshes schema.prisma after the India plans merge. Preserve
  // the same public conflict response for the unique partial indexes too.
  if ((error as { code?: string } | null)?.code === 'P2002' || (error as { code?: string } | null)?.code === '23505') {
    return res.status(409).json({ error: 'A customer with this phone or email already exists', code: 'CUSTOMER_CONFLICT' })
  }
  return null
}

/**
 * GET /records — tenant-wide customer directory. Customer identity is
 * business-wide; store scope is applied only to purchase history because a
 * person can buy at more than one shop in the same business.
 */
router.get('/records', async (req, res) => {
  const parsed = CustomerListQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid customer query' })

  const client = forTenant(req.user!.tenantId) as any
  const where: any = {}
  if (parsed.data.search) where.OR = customerSearchWhere(parsed.data.search)
  if (parsed.data.cursor) where.created_at = { lt: new Date(parsed.data.cursor) }

  const [rows, total] = await Promise.all([
    client.customers.findMany({ where, orderBy: { created_at: 'desc' }, take: parsed.data.limit + 1 }),
    client.customers.count({ where }),
  ])
  const hasMore = rows.length > parsed.data.limit
  const items = rows.slice(0, parsed.data.limit).map(toCustomerJson)
  return res.json({
    items,
    total,
    nextCursor: hasMore ? items[items.length - 1].createdAt : null,
  })
})

/**
 * GET / — compact search array retained for checkout and returns. The record
 * page uses /records so its pagination envelope can evolve independently.
 */
router.get('/', async (req, res) => {
  const query = (req.query.search as string | undefined) ?? ''
  const client = forTenant(req.user!.tenantId) as any
  const results = await searchCustomers(client, query)
  return res.json(results.map((customer) => ({
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    createdAt: customer.createdAt.toISOString(),
  })))
})

/**
 * POST / — manual profile creation. Cashiers can create a profile because the
 * same identity boundary is used at checkout; no financial or derived fields
 * are accepted here.
 */
router.post('/', requireRole('cashier'), async (req, res) => {
  const parsed = CreateCustomerInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid customer', details: parsed.error.flatten() })
  }

  try {
    const customer = await forTenantTransaction(req.user!.tenantId, (tx) =>
      createCustomer(tx, req.user!.tenantId, parsed.data),
    )
    return res.status(201).json(toCustomerJson(customer))
  } catch (error) {
    const response = writeErrorResponse(error, res)
    if (response) return response
    throw error
  }
})

/** GET /:customerId/credit — tenant-wide derived balance and recent ledger. */
router.get('/:customerId/credit', async (req, res) => {
  if (!customerIdSchema.safeParse(req.params.customerId).success) return invalidCustomerId(res)
  const customerId = req.params.customerId as string

  const result = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    if (!(await isIndiaTenant(tx, req.user!.tenantId))) return null

    const customer = await tx.customers.findFirst({
      where: { id: customerId },
      select: { id: true, credit_limit: true },
    })
    if (!customer) return null

    const totals = await getCustomerCreditTotalsForCustomer(tx, req.user!.tenantId, customer.id)
    const transactions = await tx.customer_credit_transactions.findMany({
      where: { customer_id: customer.id },
      orderBy: { created_at: 'desc' },
      take: 50,
    })
    const storeIds = [...new Set(transactions.map((row: any) => row.store_id))]
    const stores = storeIds.length
      ? await tx.stores.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } })
      : []
    const storeById = new Map<string, { id: string; name: string }>(stores.map((store: any) => [store.id, { id: store.id, name: store.name }]))

    return {
      customerId: customer.id,
      balance: moneyString(totals.balance),
      creditLimit: creditLimitString(customer.credit_limit),
      transactions: transactions.map((row: any) => toCreditTransactionJson(row, storeById)),
    }
  })

  if (!result) return res.status(404).json({ error: 'Customer not found' })
  return res.json(result)
})

/** POST /:customerId/credit/repayments — append a standalone repayment row. */
router.post('/:customerId/credit/repayments', requireRole('cashier'), async (req, res) => {
  if (!customerIdSchema.safeParse(req.params.customerId).success) return invalidCustomerId(res)
  const customerId = req.params.customerId as string

  const parsed = CreateRepaymentSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid repayment', details: parsed.error.flatten() })

  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Choose a store before recording a repayment.', code: 'choose_store' })
  }

  const result = await forTenantTransaction(req.user!.tenantId, async (tx) => {
    if (!(await isIndiaTenant(tx, req.user!.tenantId))) {
      return { status: 404 as const, body: { error: 'Customer credit is not available for this account.' } }
    }

    const customer = await lockCustomerForCredit(tx, customerId)
    if (!customer) return { status: 404 as const, body: { error: 'Customer not found' } }

    const totals = await getCustomerCreditTotalsForCustomer(tx, req.user!.tenantId, customerId)
    const amount = new Prisma.Decimal(parsed.data.amount)
    if (amount.greaterThan(totals.balance)) {
      return {
        status: 400 as const,
        body: {
          error: 'Repayment cannot be greater than the customer’s outstanding balance.',
          code: 'repayment_exceeds_balance',
          balance: moneyString(totals.balance),
        },
      }
    }

    const recordedBy = await resolveCreditRecorder(tx, req)
    if (!recordedBy) {
      return { status: 409 as const, body: { error: 'The active operator is not available for this repayment.' } }
    }

    const row = await tx.customer_credit_transactions.create({
      data: {
        tenant_id: req.user!.tenantId,
        customer_id: customerId,
        store_id: storeId,
        type: 'repayment',
        amount: parsed.data.amount,
        sale_id: null,
        recorded_by: recordedBy,
        note: parsed.data.note?.trim() || null,
      },
    })

    const stores = await tx.stores.findMany({ where: { id: storeId }, select: { id: true, name: true } })
    const storeById = new Map<string, { id: string; name: string }>(stores.map((store: any) => [store.id, { id: store.id, name: store.name }]))
    return {
      status: 201 as const,
      body: {
        transaction: toCreditTransactionJson(row, storeById),
        balance: moneyString(totals.balance.minus(amount)),
        creditLimit: creditLimitString(customer.credit_limit),
      },
    }
  })

  return res.status(result.status).json(result.body)
})

/**
 * GET /:customerId/purchases — persisted sale summaries, never a second sale
 * detail implementation. A manager is limited to their assigned shop; a
 * cashier is limited to the currently open shift on the paired counter; an
 * owner may use the existing business-wide X-Store-Id: all read scope.
 */
router.get('/:customerId/purchases', async (req, res) => {
  if (!customerIdSchema.safeParse(req.params.customerId).success) return invalidCustomerId(res)

  const parsed = CustomerPurchaseListQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid purchase history query' })

  const client = forTenant(req.user!.tenantId) as any
  const customer = await client.customers.findFirst({ where: { id: req.params.customerId } })
  if (!customer) return res.status(404).json({ error: 'Customer not found' })

  const where: any = {
    customer_id: req.params.customerId,
    ...storeScopeWhere(req),
  }

  const actingRole = req.actingStaff?.role ?? req.user!.role
  if (actingRole === 'cashier') {
    const terminal = await findPairedTerminal(client, req)
    if (!terminal) return res.status(409).json({ error: 'This device is not paired to a counter.' })
    const currentShift = await client.shifts.findFirst({
      where: { ...storeScopeWhere(req), terminal_id: terminal.id, closed_at: null },
      select: { id: true },
    })
    if (!currentShift) return res.json({ items: [], total: 0, nextCursor: null })
    where.shift_id = currentShift.id
  }

  if (parsed.data.cursor) {
    where.created_at = { lt: new Date(parsed.data.cursor) }
  }

  const [rows, total] = await Promise.all([
    client.sales.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: parsed.data.limit + 1,
      select: {
        id: true,
        store_id: true,
        total_amount: true,
        status: true,
        created_at: true,
      },
    }),
    client.sales.count({ where }),
  ])

  const page = rows.slice(0, parsed.data.limit)
  const saleIds = page.map((sale: any) => sale.id)
  const storeIds = [...new Set(page.map((sale: any) => sale.store_id).filter(Boolean))]

  const [stores, payments, taxDocuments] = saleIds.length
    ? await Promise.all([
        client.stores.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }),
        client.payments.findMany({
          where: { sale_id: { in: saleIds }, direction: 'payment' },
          select: { sale_id: true, method: true },
        }),
        // Plan 01 owns tax_documents. This optional delegate lets customer
        // history surface a document reference after that plan is integrated,
        // without copying invoice logic into the customer module.
        typeof client.tax_documents?.findMany === 'function'
          ? client.tax_documents.findMany({
              where: { sale_id: { in: saleIds } },
              select: { id: true, sale_id: true, document_number: true, document_type: true },
            })
          : Promise.resolve([]),
      ])
    : [[], [], []]

  const storeById = new Map(stores.map((store: any) => [store.id, { id: store.id, name: store.name }]))
  const paymentMethodsBySale = new Map<string, string[]>()
  for (const payment of payments) {
    const methods = paymentMethodsBySale.get(payment.sale_id) ?? []
    if (!methods.includes(payment.method)) methods.push(payment.method)
    paymentMethodsBySale.set(payment.sale_id, methods)
  }
  const documentBySale = new Map<string, any>()
  for (const document of taxDocuments) {
    const existing = documentBySale.get(document.sale_id)
    if (!existing || document.document_type === 'tax_invoice') documentBySale.set(document.sale_id, document)
  }

  const items = page.map((sale: any) => {
    const document = documentBySale.get(sale.id)
    return {
      id: sale.id,
      documentId: document?.id ?? null,
      documentNumber: document?.document_number ?? null,
      documentType: document?.document_type ?? null,
      date: iso(sale.created_at),
      store: storeById.get(sale.store_id) ?? null,
      total: sale.total_amount.toString(),
      status: sale.status,
      paymentMethods: paymentMethodsBySale.get(sale.id) ?? [],
    }
  })

  return res.json({
    items,
    total,
    nextCursor: page.length > 0 && rows.length > parsed.data.limit ? iso(page[page.length - 1].created_at) : null,
  })
})

/** GET /:customerId — tenant-scoped customer profile summary. */
router.get('/:customerId', async (req, res) => {
  if (!customerIdSchema.safeParse(req.params.customerId).success) return invalidCustomerId(res)

  const client = forTenant(req.user!.tenantId) as any
  const customer = await client.customers.findFirst({ where: { id: req.params.customerId } })
  if (!customer) return res.status(404).json({ error: 'Customer not found' })
  return res.json(toCustomerJson(customer))
})

/** PATCH /:customerId — edit only stored identity/billing fields. */
router.patch('/:customerId', requireRole('cashier'), async (req, res) => {
  if (!customerIdSchema.safeParse(req.params.customerId).success) return invalidCustomerId(res)
  const customerId = req.params.customerId as string

  const parsed = UpdateCustomerInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid customer', details: parsed.error.flatten() })
  }

  try {
    const requestedCreditLimit = parsed.data.creditLimit !== undefined ? parsed.data.creditLimit : parsed.data.credit_limit
    if (requestedCreditLimit !== undefined) {
      const role = effectiveRole(req)
      if (!role || ROLE_RANK[role] < ROLE_RANK.manager) {
        return res.status(403).json({ error: 'Only a manager or owner can change a customer credit limit.' })
      }
    }

    const { creditLimit: _creditLimit, credit_limit: _snakeCreditLimit, ...profileFields } = parsed.data
    const customer = await forTenantTransaction(req.user!.tenantId, async (tx) => {
      if (requestedCreditLimit !== undefined && !(await isIndiaTenant(tx, req.user!.tenantId))) return null
      return updateCustomer(tx, req.user!.tenantId, customerId, {
        ...profileFields,
        ...(requestedCreditLimit !== undefined ? { creditLimit: requestedCreditLimit } : {}),
        // Legacy clients may still send `name`; treat it as the same billing
        // identity instead of allowing two names to drift apart.
        billingName: parsed.data.billingName !== undefined ? parsed.data.billingName : parsed.data.name,
      })
    })
    if (!customer) return res.status(404).json({ error: 'Customer not found' })
    return res.json(toCustomerJson(customer))
  } catch (error) {
    const response = writeErrorResponse(error, res)
    if (response) return response
    throw error
  }
})

export default router
