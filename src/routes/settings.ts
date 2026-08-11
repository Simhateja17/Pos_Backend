import { Router, type Request, type Response } from 'express'
import { forTenantTransaction } from '../db/tenantClient'
import { requireRole, effectiveRole } from '../middleware/requireRole'
import { activeStoreId } from '../middleware/storeContext'
import { UpdateStoreSettingsSchema } from '../contracts/schemas/settings'

const router = Router()

const OWNER_ONLY_FIELDS = [
  'businessName',
  'tradeName',
  'gstStatus',
  'gstin',
  'pan',
  'businessType',
  'discountThresholdPercent',
  'barcodeLabelFormat',
] as const

type SettingsRole = 'owner' | 'manager'

function editableFields(role: SettingsRole) {
  const owner = role === 'owner'
  return {
    businessName: owner,
    tradeName: owner,
    addressLine1: true,
    addressLine2: true,
    city: true,
    state: true,
    postalCode: true,
    gstStatus: owner,
    gstin: owner,
    pan: owner,
    placeOfSupply: true,
    businessType: owner,
    combinedTaxRatePercent: true,
    discountThresholdPercent: owner,
    barcodeLabelFormat: owner,
  }
}

function toSettingsJson(tenant: any, store: any, role: SettingsRole) {
  const combinedFraction =
    Number(store.tax_rate_state ?? 0) +
    Number(store.tax_rate_county ?? 0) +
    Number(store.tax_rate_city ?? 0) +
    Number(store.tax_rate_district ?? 0)

  // Address and locality are store facts.  Empty strings preserve the stable
  // response shape for legacy stores whose address was not filled in yet;
  // they are never silently replaced with the registered tenant address.
  const result = {
    businessName: tenant.business_name,
    tradeName: tenant.trade_name,
    addressLine1: store.address_line1 ?? '',
    addressLine2: store.address_line2 ?? null,
    city: store.city ?? '',
    state: store.state ?? '',
    postalCode: store.postal_code ?? '',
    gstStatus: tenant.gst_status,
    gstin: tenant.tax_id,
    pan: tenant.pan,
    placeOfSupply: store.place_of_supply,
    businessType: tenant.business_type,
    combinedTaxRatePercent: (combinedFraction * 100).toFixed(4),
    discountThresholdPercent: Number(tenant.discount_threshold_percent ?? 0).toFixed(2),
    barcodeLabelFormat: tenant.barcode_label_format ?? 'code128',
    editableFields: editableFields(role),
  }

  return result
}

/**
 * Settings are a single-store surface.  `X-Store-Id: all` is meaningful for
 * aggregate dashboards but has no unambiguous address or tax row to edit.
 * Reject it before opening the tenant transaction and give clients a stable
 * machine-readable code for showing a store picker.
 */
function singleStoreId(req: Request, res: Response): string | null {
  if (req.storeContext?.scope === 'business') {
    res.status(400).json({ code: 'choose_store', error: 'Choose a store before opening store settings' })
    return null
  }
  try {
    return activeStoreId(req)
  } catch {
    res.status(400).json({ code: 'choose_store', error: 'Choose a store before opening store settings' })
    return null
  }
}

async function readSettings(req: Request, res: Response, storeId: string) {
  const role = effectiveRole(req)
  if (role !== 'owner' && role !== 'manager') {
    return res.status(403).json({ error: 'Only owners and managers can access store settings' })
  }

  const [tenant, store] = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
    const store = await tx.stores.findFirst({ where: { id: storeId, is_active: true } })
    return [tenant, store]
  })
  if (!tenant || !store) {
    return res.status(404).json({ error: !tenant ? 'Tenant not found' : 'Store not found' })
  }
  return res.json(toSettingsJson(tenant, store, role))
}

// Keep the guard on the router as well as on the route mount.  It protects
// tests/embedders that mount this router directly and ensures a cashier never
// receives a settings record from a crafted request.
router.get('/', requireRole('manager'), async (req, res) => {
  const storeId = singleStoreId(req, res)
  if (!storeId) return
  return readSettings(req, res, storeId)
})

router.patch('/', requireRole('manager'), async (req, res) => {
  const storeId = singleStoreId(req, res)
  if (!storeId) return

  const parsed = UpdateStoreSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const role = effectiveRole(req)
  if (role !== 'owner' && role !== 'manager') {
    return res.status(403).json({ error: 'Only owners and managers can access store settings' })
  }

  if (role === 'manager') {
    const forbidden = OWNER_ONLY_FIELDS.filter((field) => parsed.data[field] !== undefined)
    if (forbidden.length > 0) {
      return res.status(403).json({
        code: 'owner_only_fields',
        fields: forbidden,
        error: 'Only the owner can change these settings',
      })
    }
  }

  const {
    combinedTaxRatePercent,
    discountThresholdPercent,
    gstin,
    businessName,
    tradeName,
    gstStatus,
    pan,
    businessType,
    barcodeLabelFormat,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    placeOfSupply,
  } = parsed.data

  const tenantData: Record<string, unknown> = {}
  if (businessName !== undefined) tenantData.business_name = businessName
  if (tradeName !== undefined) tenantData.trade_name = tradeName
  if (gstStatus !== undefined) tenantData.gst_status = gstStatus
  if (gstin !== undefined) tenantData.tax_id = gstin
  if (pan !== undefined) tenantData.pan = pan
  if (businessType !== undefined) tenantData.business_type = businessType
  if (discountThresholdPercent !== undefined) tenantData.discount_threshold_percent = discountThresholdPercent
  if (barcodeLabelFormat !== undefined) tenantData.barcode_label_format = barcodeLabelFormat

  const storeData: Record<string, unknown> = {}
  if (addressLine1 !== undefined) storeData.address_line1 = addressLine1
  if (addressLine2 !== undefined) storeData.address_line2 = addressLine2
  if (city !== undefined) storeData.city = city
  if (state !== undefined) storeData.state = state
  if (postalCode !== undefined) storeData.postal_code = postalCode
  if (placeOfSupply !== undefined) storeData.place_of_supply = placeOfSupply

  if (combinedTaxRatePercent !== undefined) {
    // The API speaks in human percentages (8 means 8%), while checkout reads
    // four decimal fractions.  Keep the existing deterministic split.
    const quarter = combinedTaxRatePercent / 100 / 4
    storeData.tax_rate_state = quarter
    storeData.tax_rate_county = quarter
    storeData.tax_rate_city = quarter
    storeData.tax_rate_district = quarter
  }

  try {
    const [updatedTenant, updatedStore] = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
      const updatedTenant = Object.keys(tenantData).length > 0
        ? await tx.tenants.update({ where: { id: req.user!.tenantId }, data: tenantData })
        : await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
      const updatedStore = Object.keys(storeData).length > 0
        ? await tx.stores.update({ where: { id: storeId }, data: storeData })
        : await tx.stores.findFirst({ where: { id: storeId, is_active: true } })
      return [updatedTenant, updatedStore]
    })

    if (!updatedTenant || !updatedStore) {
      return res.status(404).json({ error: !updatedTenant ? 'Tenant not found' : 'Store not found' })
    }
    return res.json(toSettingsJson(updatedTenant, updatedStore, role))
  } catch (error: any) {
    // Same-state store invariants are enforced by the database trigger.  Keep
    // that business rule a useful client response instead of leaking a 500.
    if (error?.message?.includes('All stores must be in the business registration state')) {
      return res.status(409).json({ error: error.message })
    }
    throw error
  }
})

export default router
