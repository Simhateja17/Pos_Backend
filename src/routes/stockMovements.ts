import { activeStoreId, storeScopeWhere } from '../middleware/storeContext'
import { Router } from 'express'
import { z } from 'zod'
import { CreateStockMovementSchema } from '../contracts/schemas/stockMovement'
import { allowsFractionalQuantity } from '../contracts/schemas/product'
import { ROLE_RANK } from '../middleware/requireRole'
import { stockByVariant as stockLevelsFor, stockForVariant } from '../lib/stockLevels'
import { forTenant } from '../db/tenantClient'

const router = Router()
const MAX_STOCK_QUANTITY = 999_999_999.999

type MovementRow = {
  id: string
  variant_id: string
  movement_type: string
  quantity_delta: unknown // Prisma Decimal since 0031
  reason_code: string | null
  reason_note: string | null
  created_by: string | null
  created_at: Date
}

function toMovementJson(row: MovementRow) {
  return {
    id: row.id,
    variantId: row.variant_id,
    movementType: row.movement_type,
    quantityDelta: Number(row.quantity_delta),
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }
}

// D-13: only manager+ can record ADJUSTMENT movements; receive/transfer are
// open to any authenticated staff. Cannot use router-level requireRole()
// since the gate depends on the request body, not just the route — this
// mirrors requireRole's own acting-identity precedence exactly.
function isAllowedToAdjust(req: import('express').Request): boolean {
  const actingRole = req.actingStaff?.role ?? req.user?.role
  if (!actingRole) return false
  return ROLE_RANK[actingRole] >= ROLE_RANK.manager
}

async function resolveActingStaffId(client: any, req: import('express').Request): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  const staff = await client.staff_members.findFirst({ where: { user_id: req.user!.id, is_active: true } })
  return staff?.id ?? null
}

/**
 * POST / — record a stock movement (INV-01: append-only insert only, no
 * update/delete path exists on this router or the DB grants). The
 * variant_stock_levels balance is derived entirely by the 0008 migration's
 * trigger — this handler never writes current stock itself (INV-02).
 */
router.post('/', async (req, res) => {
  const parsed = CreateStockMovementSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
  }

  if (parsed.data.movementType === 'adjustment' && !isAllowedToAdjust(req)) {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }

  const client = forTenant(req.user!.tenantId) as any

  // CR-01: the variants FK only constrains variant_id to *some* row in
  // public.variants, not one owned by the caller's tenant, and
  // apply_stock_movement() is SECURITY DEFINER so it bypasses RLS on
  // update. Without this check an attacker can corrupt another tenant's
  // stock levels / identity-lock their variants by guessing a UUID.
  // findFirst here is RLS-scoped via forTenant(), so a variant belonging
  // to another tenant simply won't be found.
  const variant = await client.variants.findFirst({ where: { id: parsed.data.variantId } })
  if (!variant) {
    return res.status(404).json({ error: 'Variant not found' })
  }

  if (variant.track_inventory === false) {
    return res.status(409).json({ error: 'Inventory tracking is turned off for this item.' })
  }

  // Whether a fraction is meaningful depends on the variant's unit, which the
  // request schema cannot see. Rice sold loose (kg) moves 2.5; a shirt (piece)
  // never does, and a fractional piece is a typo the ledger should refuse.
  if (
    !allowsFractionalQuantity(variant.unit_of_measure) &&
    !Number.isInteger(parsed.data.quantityDelta)
  ) {
    return res.status(400).json({
      error: `Quantity must be a whole number for a variant measured in ${variant.unit_of_measure}`,
    })
  }

  const currentStock = await stockForVariant(client, req, parsed.data.variantId)
  const projectedStock = currentStock + parsed.data.quantityDelta
  if (!Number.isFinite(projectedStock) || Math.abs(projectedStock) > MAX_STOCK_QUANTITY) {
    return res.status(400).json({
      error: `Quantity is outside the supported range. Current stock is ${currentStock}.`,
    })
  }

  const createdBy = await resolveActingStaffId(client, req)

  try {
    const movement = await client.stock_movements.create({
      data: {
        tenant_id: req.user!.tenantId,
        store_id: activeStoreId(req),
        variant_id: parsed.data.variantId,
        movement_type: parsed.data.movementType,
        quantity_delta: parsed.data.quantityDelta,
        reason_code: parsed.data.reasonCode ?? null,
        reason_note: parsed.data.reasonNote ?? null,
        created_by: createdBy,
      },
    })
    return res.status(201).json(toMovementJson(movement))
  } catch {
    return res.status(400).json({ error: 'Could not record stock movement' })
  }
})

/**
 * GET /?variantId=X — read-only chronological movement history for one
 * variant (INV-01). No mutation route exists for this data anywhere.
 */
router.get('/', async (req, res) => {
  const variantId = req.query.variantId as string | undefined
  if (!variantId) {
    return res.status(400).json({ error: 'variantId query parameter is required' })
  }
  if (!z.string().uuid().safeParse(variantId).success) {
    return res.status(400).json({ error: 'Invalid variantId' })
  }
  const client = forTenant(req.user!.tenantId) as any
  const rows = await client.stock_movements.findMany({
    where: { variant_id: variantId, ...storeScopeWhere(req) },
    orderBy: { created_at: 'desc' },
  })
  res.json(rows.map(toMovementJson))
})

/**
 * GET /low-stock — variants at/below their reorder_threshold (INV-03). Uses
 * model-level findMany + in-memory filter rather than $queryRaw, since
 * forTenant()'s tenant-context wrapper only intercepts $allModels operations,
 * NOT $queryRaw (see tenantClient.ts's own documented caveat) — a raw query
 * here would silently run with no tenant context set.
 */
router.get('/low-stock', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const variants = await client.variants.findMany({ where: { track_inventory: true, products: { is_active: true } } })
  // Low stock is a PER-SHOP fact: Andheri being out matters even when Bandra
  // is full, so this must not aggregate unless the owner explicitly asked for
  // business scope.
  const stockByVariant = await stockLevelsFor(client, req)
  const productIds = [...new Set(variants.map((v: any) => v.product_id))]
  const products = await client.products.findMany({ where: { id: { in: productIds } } })
  const productNameById = new Map(products.map((p: any) => [p.id, p.name]))

  const lowStock = variants
    .map((v: any) => ({ v, quantity: Number(stockByVariant.get(v.id) ?? 0) }))
    .filter(({ v, quantity }: any) => quantity <= Number(v.reorder_threshold))
    .map(({ v, quantity }: any) => ({
      variantId: v.id,
      productId: v.product_id,
      productName: productNameById.get(v.product_id) ?? '',
      sku: v.sku,
      size: v.size,
      color: v.color,
      material: v.material,
      quantity,
      reorderThreshold: Number(v.reorder_threshold),
      unitOfMeasure: v.unit_of_measure,
    }))

  res.json(lowStock)
})

export default router
