import { Router } from 'express'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { storeAllowance, storeLimitMessage } from '../services/storeLimit'
import { requireRole } from '../middleware/requireRole'
import { CreateStoreSchema, UpdateStoreSchema } from '../contracts/schemas/store'

const router = Router()

function toStoreJson(row: any, ownStoreId: string) {
  return {
    id: row.id,
    name: row.name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    isOwnStore: row.id === ownStoreId,
    // Rates are serialised as strings, matching how every other numeric leaves
    // this API — a JS number cannot hold numeric(6,4) without rounding risk,
    // and tax rates are money-adjacent.
    taxRateState: String(row.tax_rate_state),
    taxRateCounty: String(row.tax_rate_county),
    taxRateCity: String(row.tax_rate_city),
    taxRateDistrict: String(row.tax_rate_district),
    placeOfSupply: row.place_of_supply,
  }
}

/**
 * GET / — the business's shops.
 *
 * An OWNER sees every shop; that list is what the Stores module renders.
 * A manager or cashier sees ONLY their own shop. They have no Stores module and
 * no reason to enumerate the business's other outlets — but the app shell still
 * needs to name the shop they are standing in.
 */
router.get('/', async (req, res) => {
  const ownStoreId = req.user!.storeId
  const isOwner = req.user!.role === 'owner'

  const { stores, allowance } = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const stores = await tx.stores.findMany({
      where: isOwner ? {} : { id: ownStoreId },
      orderBy: [{ created_at: 'asc' }],
    })
    // Only the owner can open a shop, so only the owner is told how many are
    // left. Showing a manager an allowance they cannot spend is noise.
    const allowance = isOwner ? await storeAllowance(tx, req.user!.tenantId) : null
    return { stores, allowance }
  })

  res.json({
    stores: stores.map((row: any) => toStoreJson(row, ownStoreId)),
    // Lets the Stores screen say "2 of 3 used" and disable Add before the
    // owner fills in a form that is going to be refused. The server still
    // enforces it on POST — this is a courtesy, not the check.
    storeAllowance: allowance,
  })
})

/**
 * POST / — open a new shop. Owner only: adding an outlet is a business
 * decision and a billing event.
 */
router.post('/', requireRole('owner'), async (req, res) => {
  const parsed = CreateStoreSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid store', details: parsed.error.flatten() })
  }

  const input = parsed.data
  const client = forTenant(req.user!.tenantId) as any

  // Task 12: refuse past the plan's shop allowance, with an upgrade path.
  // Deliberately NOT silently allowed — an unbilled shop is worse than a
  // blocked one, and an owner who discovers months later that three outlets
  // were never charged for has a worse conversation than one told today.
  //
  // 409 rather than 402: the request is well-formed and the caller is
  // entitled to use the API. What is exhausted is an allowance, which is a
  // conflict with current state rather than a payment failure — a 402 would
  // also collide with requireSubscription's meaning of "you are not paid up".
  const allowance = await forTenantTransaction(req.user!.tenantId, async (tx: any) =>
    storeAllowance(tx, req.user!.tenantId),
  )
  if (!allowance.canAddStore) {
    return res.status(409).json({
      error: storeLimitMessage(allowance),
      storeAllowance: allowance,
    })
  }

  try {
    const created = await client.stores.create({
      data: {
        tenant_id: req.user!.tenantId,
        name: input.name,
        address_line1: input.addressLine1 ?? null,
        address_line2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postal_code: input.postalCode ?? null,
        ...(input.country ? { country: input.country } : {}),
        ...(input.taxRateState !== undefined ? { tax_rate_state: input.taxRateState } : {}),
        ...(input.taxRateCounty !== undefined ? { tax_rate_county: input.taxRateCounty } : {}),
        ...(input.taxRateCity !== undefined ? { tax_rate_city: input.taxRateCity } : {}),
        ...(input.taxRateDistrict !== undefined ? { tax_rate_district: input.taxRateDistrict } : {}),
        place_of_supply: input.placeOfSupply ?? null,
      },
    })
    res.status(201).json(toStoreJson(created, req.user!.storeId))
  } catch (error: any) {
    // 0041's case-insensitive unique index on (tenant_id, lower(name)).
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'A store with that name already exists' })
    }
    throw error
  }
})

/**
 * PATCH /:storeId — rename, re-address, retax, or deactivate a shop.
 *
 * Deactivate, never delete: a store is referenced by historical sales, shifts
 * and Z reports, which must keep naming the shop they happened at.
 */
router.patch('/:storeId', requireRole('owner'), async (req, res) => {
  const parsed = UpdateStoreSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid store', details: parsed.error.flatten() })
  }

  const input = parsed.data
  const client = forTenant(req.user!.tenantId) as any
  const storeId = req.params.storeId

  const existing = await client.stores.findFirst({ where: { id: storeId } })
  if (!existing) {
    return res.status(404).json({ error: 'Store not found' })
  }

  // A business must always have at least one active shop. Without this an owner
  // could deactivate their last store and lock every staff member out of a
  // business that still has stock, staff and history in it.
  if (input.isActive === false && existing.is_active) {
    const activeCount = await client.stores.count({ where: { is_active: true } })
    if (activeCount <= 1) {
      return res.status(409).json({ error: 'A business must have at least one active store' })
    }
  }

  const data: Record<string, unknown> = {}
  if (input.name !== undefined) data.name = input.name
  if (input.addressLine1 !== undefined) data.address_line1 = input.addressLine1
  if (input.addressLine2 !== undefined) data.address_line2 = input.addressLine2
  if (input.city !== undefined) data.city = input.city
  if (input.state !== undefined) data.state = input.state
  if (input.postalCode !== undefined) data.postal_code = input.postalCode
  if (input.country !== undefined) data.country = input.country
  if (input.isActive !== undefined) data.is_active = input.isActive
  if (input.taxRateState !== undefined) data.tax_rate_state = input.taxRateState
  if (input.taxRateCounty !== undefined) data.tax_rate_county = input.taxRateCounty
  if (input.taxRateCity !== undefined) data.tax_rate_city = input.taxRateCity
  if (input.taxRateDistrict !== undefined) data.tax_rate_district = input.taxRateDistrict
  if (input.placeOfSupply !== undefined) data.place_of_supply = input.placeOfSupply

  try {
    const updated = await client.stores.update({ where: { id: storeId }, data })
    res.json(toStoreJson(updated, req.user!.storeId))
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'A store with that name already exists' })
    }
    throw error
  }
})

export default router
