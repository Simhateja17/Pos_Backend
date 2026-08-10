import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import { UpdateStoreSettingsSchema } from '../contracts/schemas/settings'

const router = Router()

function toSettingsJson(tenant: any) {
  const combined =
    Number(tenant.tax_rate_state) +
    Number(tenant.tax_rate_county) +
    Number(tenant.tax_rate_city) +
    Number(tenant.tax_rate_district)

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
    placeOfSupply: tenant.place_of_supply,
    businessType: tenant.business_type,
    combinedTaxRatePercent: combined.toFixed(4),
    discountThresholdPercent: Number(tenant.discount_threshold_percent).toFixed(2),
    // 0050 default, restated here so a tenant row read before the migration
    // lands still serialises a valid enum value rather than undefined.
    barcodeLabelFormat: tenant.barcode_label_format ?? 'code128',
  }
}

/** GET / — read is open to any staff role; only owners can change these. */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const tenant = await client.tenants.findFirst({ where: { id: req.user!.tenantId } })
  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' })
  }
  return res.json(toSettingsJson(tenant))
})

router.patch('/', requireRole('owner'), async (req, res) => {
  const parsed = UpdateStoreSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any
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
    ...(rest.placeOfSupply !== undefined ? { place_of_supply: rest.placeOfSupply } : {}),
    ...(discountThresholdPercent !== undefined
      ? { discount_threshold_percent: discountThresholdPercent }
      : {}),
    ...(rest.barcodeLabelFormat !== undefined
      ? { barcode_label_format: rest.barcodeLabelFormat }
      : {}),
  }

  if (combinedTaxRatePercent !== undefined) {
    // Split evenly across the four jurisdiction columns (see the schema
    // comment) — nothing reads them individually today; checkout only ever
    // sums all four back into one rate.
    const quarter = combinedTaxRatePercent / 4
    data.tax_rate_state = quarter
    data.tax_rate_county = quarter
    data.tax_rate_city = quarter
    data.tax_rate_district = quarter
  }

  const updated = await client.tenants.update({ where: { id: req.user!.tenantId }, data })
  return res.json(toSettingsJson(updated))
})

export default router
