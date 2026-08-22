import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'
process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}))

const tenantsFindFirstMock = vi.fn()
const tenantsUpdateMock = vi.fn()
const storesFindFirstMock = vi.fn()
const storesUpdateMock = vi.fn()
const membershipFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    staff_members: { findFirst: membershipFindFirstMock },
    tenants: { findFirst: tenantsFindFirstMock, update: tenantsUpdateMock },
  })),
  forTenantTransaction: vi.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) =>
    fn({
      tenants: { findFirst: tenantsFindFirstMock, update: tenantsUpdateMock },
      stores: { findFirst: storesFindFirstMock, update: storesUpdateMock },
      staff_members: { findFirst: membershipFindFirstMock },
      billing_subscriptions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      terminals: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
      staff_sessions: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
    }),
  ),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier') {
  return fakeJwt({ sub: 'user-123', role, tenant_id: 'tenant-real' })
}

function storeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-1',
    name: 'Main store',
    tax_rate_state: 0,
    tax_rate_county: 0,
    tax_rate_city: 0,
    tax_rate_district: 0,
    country: 'IN',
    place_of_supply: null,
    ...overrides,
  }
}

function tenantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-real',
    business_name: 'Example Retail',
    trade_name: null,
    address_line1: '12 MG Road',
    address_line2: null,
    city: 'Hyderabad',
    state: 'Telangana',
    postal_code: '500001',
    gst_status: null,
    tax_id: null,
    pan: null,
    place_of_supply: null,
    business_type: null,
    tax_rate_state: 0,
    tax_rate_county: 0,
    tax_rate_city: 0,
    tax_rate_district: 0,
    discount_threshold_percent: 15,
    country: 'IN',
    ...overrides,
  }
}

describe('settings routes', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    tenantsFindFirstMock.mockReset()
    tenantsUpdateMock.mockReset()
    storesFindFirstMock.mockReset().mockResolvedValue(storeRow())
    storesUpdateMock.mockReset()
    tenantsFindFirstMock.mockResolvedValue(tenantRow())
    membershipFindFirstMock.mockReset().mockImplementation(({ where }: { where: { role?: string } }) => ({
      role: where.role,
      tenant_id: 'tenant-real', store_id: 'store-1', is_active: true,
    }))
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { operatorContext } = await import('../../src/middleware/operatorContext')
    const { storeContextMiddleware } = await import('../../src/middleware/storeContext')
    const { default: settingsRouter } = await import('../../src/routes/settings')
    const app = express()
    app.use(express.json())
    app.use('/settings', authMiddleware, operatorContext, storeContextMiddleware, settingsRouter)
    return app
  }

  it('reads settings with the four tax jurisdictions collapsed into one combined rate for an owner', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow())
    storesFindFirstMock.mockResolvedValue(
      storeRow({ tax_rate_state: 0.025, tax_rate_county: 0.01, tax_rate_city: 0.005, tax_rate_district: 0 }),
    )
    const app = await buildApp()

    const response = await request(app).get('/settings').set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(response.status).toBe(200)
    expect(response.body.combinedTaxRatePercent).toBe('4.0000')
    expect(response.body.businessName).toBe('Example Retail')
  })

  it('denies a cashier from reading settings', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow())
    const app = await buildApp()

    const response = await request(app).get('/settings').set('Authorization', `Bearer ${tokenFor('cashier')}`)

    expect(response.status).toBe(403)
    expect(tenantsFindFirstMock).not.toHaveBeenCalled()
  })

  it('returns a clear scope error instead of a 500 for an all-stores request', async () => {
    const app = await buildApp()

    const response = await request(app)
      .get('/settings')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .set('X-Store-Id', 'all')

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Choose a store before opening store settings')
    expect(tenantsFindFirstMock).not.toHaveBeenCalled()
    expect(storesFindFirstMock).not.toHaveBeenCalled()
  })

  it.each(['manager', 'cashier'] as const)('denies %s a settings write', async (role) => {
    const app = await buildApp()
    const response = await request(app)
      .patch('/settings')
      .set('Authorization', `Bearer ${tokenFor(role)}`)
      .send({ businessName: 'New Name' })

    expect(response.status).toBe(403)
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
  })

  it('lets a manager update only the selected store address, locality and tax rate', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow())
    storesUpdateMock.mockImplementation(async ({ data }: { data: any }) => storeRow(data))
    const app = await buildApp()

    const response = await request(app)
      .patch('/settings')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)
      .send({ addressLine1: '99 New Road', city: 'Pune', placeOfSupply: 'Maharashtra', combinedTaxRatePercent: 8 })

    expect(response.status).toBe(200)
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
    expect(storesUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'store-1' },
        data: expect.objectContaining({ address_line1: '99 New Road', city: 'Pune', place_of_supply: 'Maharashtra', tax_rate_state: 0.02 }),
      }),
    )
    expect(response.body.editableFields.businessName).toBe(false)
    expect(response.body.editableFields.addressLine1).toBe(true)
  })

  it('lets the owner update settings, spreading a combined tax rate across all four columns', async () => {
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) => tenantRow(data))
    storesUpdateMock.mockImplementation(async ({ data }: { data: any }) => storeRow(data))
    const app = await buildApp()

    const response = await request(app)
      .patch('/settings')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ businessName: 'Renamed Store', combinedTaxRatePercent: 8, discountThresholdPercent: 10 })

    expect(response.status).toBe(200)
    expect(tenantsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-real' },
        data: expect.objectContaining({
          business_name: 'Renamed Store',
          discount_threshold_percent: 10,
        }),
      }),
    )
    expect(storesUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'store-1' },
        data: expect.objectContaining({
          tax_rate_state: 0.02,
          tax_rate_county: 0.02,
          tax_rate_city: 0.02,
          tax_rate_district: 0.02,
        }),
      }),
    )
    expect(response.body.combinedTaxRatePercent).toBe('8.0000')
  })

  it('maps gstin in the request to the tax_id column', async () => {
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) => tenantRow(data))
    storesUpdateMock.mockImplementation(async ({ data }: { data: any }) => storeRow(data))
    const app = await buildApp()

    await request(app)
      .patch('/settings')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ gstin: '27ABCDE1234F1Z5' })

    expect(tenantsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tax_id: '27ABCDE1234F1Z5' }) }),
    )
  })

  it('round-trips International sales-tax jurisdiction rates through PUT without GST fields', async () => {
    let currentTenant = tenantRow({
      country: 'US',
      gst_status: 'regular',
      tax_id: 'should-not-be-touched',
    })
    let currentStore = storeRow()
    tenantsFindFirstMock.mockImplementation(async () => currentTenant)
    storesFindFirstMock.mockImplementation(async () => currentStore)
    storesUpdateMock.mockImplementation(async ({ data }: { data: any }) => {
      currentStore = storeRow({ ...currentStore, ...data })
      return currentStore
    })
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) => {
      currentTenant = tenantRow({ ...currentTenant, ...data })
      return currentTenant
    })
    const app = await buildApp()

    const response = await request(app)
      .put('/settings')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ salesTaxRates: { state: 4.5, county: 1.25, city: 0.5, district: 0 } })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      region: 'INTL',
      salesTaxRates: { state: '4.5000', county: '1.2500', city: '0.5000', district: '0.0000' },
    })
    expect(response.body).not.toHaveProperty('gstStatus')
    expect(response.body).not.toHaveProperty('gstin')
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
    expect(storesUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        tax_rate_state: 0.045,
        tax_rate_county: 0.0125,
        tax_rate_city: 0.005,
        tax_rate_district: 0,
      },
    }))

    const readback = await request(app)
      .get('/settings')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
    expect(readback.status).toBe(200)
    expect(readback.body.salesTaxRates).toEqual({
      state: '4.5000', county: '1.2500', city: '0.5000', district: '0.0000',
    })
    expect(readback.body).not.toHaveProperty('gstStatus')
    expect(readback.body).not.toHaveProperty('gstin')
  })

  it('rejects Indian combined-rate writes from an International tenant', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow({ country: 'US' }))
    const app = await buildApp()

    const response = await request(app)
      .put('/settings')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ combinedTaxRatePercent: 8 })

    expect(response.status).toBe(400)
    expect(storesUpdateMock).not.toHaveBeenCalled()
  })
})
