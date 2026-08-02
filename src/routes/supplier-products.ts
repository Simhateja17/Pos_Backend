import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  CreateSupplierProductInputSchema,
  UpdateSupplierProductInputSchema,
} from '../contracts/schemas/supplierProduct'
import { forTenant } from '../db/tenantClient'

const uuidSchema = z.string().uuid()

// mergeParams: mounted under /variants/:variantId/supplier-products.
const router = Router({ mergeParams: true })

type Params = { variantId: string; supplierProductId?: string }
const asHandler = (fn: RequestHandler<Params>) => fn

type SupplierProductRow = {
  id: string
  supplier_id: string
  variant_id: string
  is_primary: boolean
  lead_time_days: number
  unit_cost: unknown // Prisma Decimal | null
  supplier_sku: string | null
  min_order_qty: number | null
  created_at: Date
  suppliers: { name: string }
}

function toSupplierProductJson(row: SupplierProductRow) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.suppliers.name,
    variantId: row.variant_id,
    isPrimary: row.is_primary,
    leadTimeDays: row.lead_time_days,
    unitCost: row.unit_cost === null ? null : (row.unit_cost as { toString(): string }).toString(),
    supplierSku: row.supplier_sku,
    minOrderQty: row.min_order_qty,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * GET /variants/:variantId/supplier-products — every supplier this variant is
 * bought from, primary first. No requireRole gate, matching suppliers.ts.
 */
router.get('/', asHandler(async (req, res) => {
  if (!uuidSchema.safeParse(req.params.variantId).success) {
    return res.status(400).json({ error: 'Invalid variantId' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const rows = await client.supplier_products.findMany({
    where: { variant_id: req.params.variantId },
    include: { suppliers: true },
    orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
  })
  res.json(rows.map(toSupplierProductJson))
}))

/**
 * POST /variants/:variantId/supplier-products — link a supplier to this
 * variant. isPrimary: true demotes any existing primary for the variant first
 * (the DB's partial unique index is the actual guarantee against a race; this
 * is just so a normal single-request call doesn't 500 into it).
 */
router.post('/', asHandler(async (req, res) => {
  if (!uuidSchema.safeParse(req.params.variantId).success) {
    return res.status(400).json({ error: 'Invalid variantId' })
  }
  const parsed = CreateSupplierProductInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any

  const variant = await client.variants.findFirst({ where: { id: req.params.variantId } })
  if (!variant) {
    return res.status(404).json({ error: 'Variant not found' })
  }
  const supplier = await client.suppliers.findFirst({ where: { id: parsed.data.supplierId } })
  if (!supplier) {
    return res.status(404).json({ error: 'Supplier not found' })
  }

  try {
    const created = await client.$transaction(async (tx: any) => {
      if (parsed.data.isPrimary) {
        await tx.supplier_products.updateMany({
          where: { variant_id: req.params.variantId, is_primary: true },
          data: { is_primary: false },
        })
      }
      return tx.supplier_products.create({
        data: {
          tenant_id: req.user!.tenantId,
          supplier_id: parsed.data.supplierId,
          variant_id: req.params.variantId,
          is_primary: parsed.data.isPrimary ?? false,
          lead_time_days: parsed.data.leadTimeDays,
          unit_cost: parsed.data.unitCost ?? null,
          supplier_sku: parsed.data.supplierSku ?? null,
          min_order_qty: parsed.data.minOrderQty ?? null,
        },
        include: { suppliers: true },
      })
    })
    res.status(201).json(toSupplierProductJson(created))
  } catch (cause: any) {
    if (cause?.code === 'P2002') {
      return res.status(409).json({ error: 'This supplier is already linked to this variant' })
    }
    throw cause
  }
}))

/**
 * PATCH /variants/:variantId/supplier-products/:supplierProductId — edit the
 * link, or flip isPrimary. Same demote-then-set approach as create.
 */
router.patch('/:supplierProductId', asHandler(async (req, res) => {
  if (!uuidSchema.safeParse(req.params.variantId).success) {
    return res.status(400).json({ error: 'Invalid variantId' })
  }
  if (!uuidSchema.safeParse(req.params.supplierProductId).success) {
    return res.status(400).json({ error: 'Invalid supplierProductId' })
  }
  const parsed = UpdateSupplierProductInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.supplier_products.findFirst({
    where: { id: req.params.supplierProductId, variant_id: req.params.variantId },
  })
  if (!existing) {
    return res.status(404).json({ error: 'Supplier product link not found' })
  }

  const updated = await client.$transaction(async (tx: any) => {
    if (parsed.data.isPrimary) {
      await tx.supplier_products.updateMany({
        where: { variant_id: req.params.variantId, is_primary: true, id: { not: existing.id } },
        data: { is_primary: false },
      })
    }
    return tx.supplier_products.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.isPrimary !== undefined ? { is_primary: parsed.data.isPrimary } : {}),
        ...(parsed.data.leadTimeDays !== undefined ? { lead_time_days: parsed.data.leadTimeDays } : {}),
        ...(parsed.data.unitCost !== undefined ? { unit_cost: parsed.data.unitCost } : {}),
        ...(parsed.data.supplierSku !== undefined ? { supplier_sku: parsed.data.supplierSku } : {}),
        ...(parsed.data.minOrderQty !== undefined ? { min_order_qty: parsed.data.minOrderQty } : {}),
      },
      include: { suppliers: true },
    })
  })
  res.json(toSupplierProductJson(updated))
}))

/**
 * DELETE /variants/:variantId/supplier-products/:supplierProductId — unlink.
 * Unlike suppliers, nothing else references this row by id (purchase orders
 * reference supplier_id/variant_id directly), so a hard delete is safe.
 */
router.delete('/:supplierProductId', asHandler(async (req, res) => {
  if (!uuidSchema.safeParse(req.params.variantId).success) {
    return res.status(400).json({ error: 'Invalid variantId' })
  }
  if (!uuidSchema.safeParse(req.params.supplierProductId).success) {
    return res.status(400).json({ error: 'Invalid supplierProductId' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const existing = await client.supplier_products.findFirst({
    where: { id: req.params.supplierProductId, variant_id: req.params.variantId },
  })
  if (!existing) {
    return res.status(404).json({ error: 'Supplier product link not found' })
  }
  await client.supplier_products.delete({ where: { id: existing.id } })
  res.status(204).send()
}))

export default router
