import { Router } from 'express'
import { forTenantTransaction } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import { activeStoreId } from '../middleware/storeContext'
import { UpdateStoreSettingsSchema } from '../contracts/schemas/settings'

const router = Router()

function toSettingsJson(tenant: any, store: any) {
  const combinedFraction =
    Number(store.tax_rate_state) +
    Number(store.tax_rate_county) +
    Number(store.tax_rate_city) +
    Number(store.tax_rate_district)

  return {
    businessName: tenant.business_name,
    tradeName: tenant.trade_name,
    addressLine1: tenant.address_line1,
    addressLine2: tenant.address_line2,
    city: tenant.city,
    state: tenant.state,
    postalCode: tenant.postal_code,
    gstStatus: tenant.gst_status,
    gstin: tenant.tax_id,
    pan: tenant.pan,
    placeOfSupply: store.place_of_supply,
    businessType: tenant.business_type,
    combinedTaxRatePercent: (combinedFraction * 100).toFixed(4),
    discountThresholdPercent: Number(tenant.discount_threshold_percent).toFixed(2),
    // 0050 default, restated here so a tenant row read before the migration
    // lands still serialises a valid enum value rather than undefined.
    barcodeLabelFormat: tenant.barcode_label_format ?? 'code128',
  }
}

/** GET / — read is open to any staff role; only owners can change these. */
router.get('/', async (req, res) => {
  const [tenant, store] = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const tenant = await tx.tenants.findFirst({ where: { id: req.user!.tenantId } })
    const store = await tx.stores.findFirst({ where: { id: activeStoreId(req), is_active: true } })
    return [tenant, store]
  })
  if (!tenant || !store) {
    return res.status(404).json({ error: !tenant ? 'Tenant not found' : 'Store not found' })
  }
  return res.json(toSettingsJson(tenant, store))
})

router.patch('/', requireRole('owner'), async (req, res) => {
  const parsed = UpdateStoreSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const { combinedTaxRatePercent, discountThresholdPercent, gstin, ...rest } = parsed.data

  const data: Record<string, unknown> = {
    ...(rest.businessName !== undefined ? { business_name: rest.businessName } : {}),
    ...(rest.tradeName !== undefined ? { trade_name: rest.tradeName } : {}),
    ...(rest.addressLine1 !== undefined ? { address_line1: rest.addressLine1 } : {}),
    ...(rest.addressLine2 !== undefined ? { address_line2: rest.addressLine2 } : {}),
    ...(rest.city !== undefined ? { city: rest.city } : {}),
    ...(rest.state !== undefined ? { state: rest.state } : {}),
    ...(rest.postalCode !== undefined ? { postal_code: rest.postalCode } : {}),
    ...(rest.gstStatus !== undefined ? { gst_status: rest.gstStatus } : {}),
    ...(gstin !== undefined ? { tax_id: gstin } : {}),
    ...(rest.pan !== undefined ? { pan: rest.pan } : {}),
    ...(discountThresholdPercent !== undefined
      ? { discount_threshold_percent: discountThresholdPercent }
      : {}),
    ...(rest.barcodeLabelFormat !== undefined
      ? { barcode_label_format: rest.barcodeLabelFormat }
      : {}),
  }
  const storeData: Record<string, unknown> = {}

  if (combinedTaxRatePercent !== undefined) {
    // The UI speaks in human percentages (8 means 8%), while checkout expects
    // a decimal fraction (0.08). Store that fraction evenly across the four
    // jurisdiction columns; checkout sums them back into one rate.
    const quarter = combinedTaxRatePercent / 100 / 4
    storeData.tax_rate_state = quarter
    storeData.tax_rate_county = quarter
    storeData.tax_rate_city = quarter
    storeData.tax_rate_district = quarter
  }

  if (rest.placeOfSupply !== undefined) storeData.place_of_supply = rest.placeOfSupply

  const [updatedTenant, updatedStore] = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const updatedTenant = await tx.tenants.update({ where: { id: req.user!.tenantId }, data })
    const updatedStore = await tx.stores.update({ where: { id: activeStoreId(req) }, data: storeData })
    return [updatedTenant, updatedStore]
  })
  return res.json(toSettingsJson(updatedTenant, updatedStore))
})

export default router
