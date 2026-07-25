import { Router } from 'express'
import { z } from 'zod'
import { CreateSupplierInputSchema, UpdateSupplierInputSchema } from '../contracts/schemas/supplier'
import { forTenant } from '../db/tenantClient'

const uuidSchema = z.string().uuid()

const router = Router()

type SupplierRow = {
  id: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  lead_time_days: number
  min_order_value: unknown // Prisma Decimal | null
  payment_terms: string | null
  is_active: boolean
  created_at: Date
}

function toSupplierJson(row: SupplierRow) {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    leadTimeDays: row.lead_time_days,
    minOrderValue: row.min_order_value === null ? null : (row.min_order_value as { toString(): string }).toString(),
    paymentTerms: row.payment_terms,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * GET / — list the caller's tenant's suppliers, active first. No requireRole
 * gate: viewing/managing the vendor directory is not a sensitive action per
 * the gating precedent set in products.ts/customers.ts (only discounts and
 * stock adjustments are gated per D-13).
 */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const suppliers = await client.suppliers.findMany({
    orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
  })
  res.json(suppliers.map(toSupplierJson))
})

router.get('/:supplierId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.supplierId).success) {
    return res.status(400).json({ error: 'Invalid supplierId' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const supplier = await client.suppliers.findFirst({ where: { id: req.params.supplierId } })
  if (!supplier) {
    return res.status(404).json({ error: 'Supplier not found' })
  }
  res.json(toSupplierJson(supplier))
})

router.post('/', async (req, res) => {
  const parsed = CreateSupplierInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const supplier = await client.suppliers.create({
    data: {
      tenant_id: req.user!.tenantId,
      name: parsed.data.name,
      contact_name: parsed.data.contactName ?? null,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      address: parsed.data.address ?? null,
      lead_time_days: parsed.data.leadTimeDays,
      min_order_value: parsed.data.minOrderValue ?? null,
      payment_terms: parsed.data.paymentTerms ?? null,
    },
  })
  res.status(201).json(toSupplierJson(supplier))
})

/**
 * PATCH /:supplierId — edit, or deactivate/reactivate via isActive. There is
 * no DELETE: suppliers referenced by past purchase orders and reorder
 * suggestions must remain resolvable, so removal is always a soft
 * deactivation (PUR-01's "deactivated," not "deleted").
 */
router.patch('/:supplierId', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.supplierId).success) {
    return res.status(400).json({ error: 'Invalid supplierId' })
  }
  const parsed = UpdateSupplierInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.suppliers.findFirst({ where: { id: req.params.supplierId } })
  if (!existing) {
    return res.status(404).json({ error: 'Supplier not found' })
  }

  const updated = await client.suppliers.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.contactName !== undefined ? { contact_name: parsed.data.contactName } : {}),
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
      ...(parsed.data.leadTimeDays !== undefined ? { lead_time_days: parsed.data.leadTimeDays } : {}),
      ...(parsed.data.minOrderValue !== undefined ? { min_order_value: parsed.data.minOrderValue } : {}),
      ...(parsed.data.paymentTerms !== undefined ? { payment_terms: parsed.data.paymentTerms } : {}),
      ...(parsed.data.isActive !== undefined ? { is_active: parsed.data.isActive } : {}),
    },
  })
  res.json(toSupplierJson(updated))
})

export default router
