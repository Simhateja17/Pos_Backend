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

vi.mock('../../src/services/billing', () => ({
  getBillingStatus: vi.fn(async () => ({
    hasSubscription: true,
    entitlement: 'active',
    accessAllowed: true,
    graceUntil: null,
    subscription: null,
  })),
}))

const tenantsFindFirstMock = vi.fn()
const tenantsUpdateMock = vi.fn()
const membershipFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    staff_members: { findFirst: membershipFindFirstMock },
    tenants: {
      findFirst: tenantsFindFirstMock,
      update: tenantsUpdateMock,
    },
  })),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier', tenantId = 'tenant-real') {
  return fakeJwt({ sub: 'user-123', role, tenant_id: tenantId })
}

// Step 1 is plan selection only; business identity and GST moved to signup.
// There is no step 2 — the numbering gap is deliberate so already-persisted
// onboarding_data keeps its meaning.
const stepFixtures = {
  '1': {
    trialPlan: 'growth',
    billingCycle: 'monthly',
  },
  '3': {
    storeName: 'Bandra Flagship',
    addressLine1: '12 Hill Road',
    postalCode: '400050',
    city: 'Mumbai',
    state: 'Maharashtra',
    storeType: 'high_street',
    storeClassification: 'flagship',
    openingTime: '10:00',
  },
  '4': {
    invoicePrefix: 'INV-',
    invoiceStartNumber: 1,
    paymentTermsDays: '0',
    gstPricingMode: 'inclusive',
    defaultGstSlab: '18',
    rounding: 'nearest1',
    financialYearStart: 'april',
    printHsn: true,
    printDuplicateCopy: false,
    invoiceQrEnabled: false,
    invoiceFooter: 'Thank you for shopping with us!',
  },
  '5': {
    cashEnabled: true,
    maxCashPerTransaction: 200000,
    upiEnabled: true,
    upiPartner: 'razorpay',
    soundBoxEnabled: false,
    cardEnabled: true,
    cardProvider: 'pinelabs',
    contactlessEnabled: true,
    emiEnabled: false,
    giftCardEnabled: false,
    storeCreditEnabled: false,
    splitPaymentEnabled: true,
    advancePaymentEnabled: false,
  },
  '6': {
    skuCount: '500-2000',
    importMethod: 'csv',
    unitOfMeasure: 'piece',
    barcodeFormat: 'ean13',
    hsnAutoLookup: true,
    mrpRequired: true,
    variantTracking: true,
    batchTracking: false,
    expiryTracking: false,
    serialTracking: false,
    serviceItemsEnabled: false,
    negativeStockPolicy: 'block',
  },
  '7': {
    billingCounters: '2',
    printerConnection: 'cloud',
    paperWidthMm: '80',
    scannerConnection: 'usb',
    cashDrawerMode: 'auto',
    cardTerminalType: 'pinelabs',
    customerDisplayEnabled: false,
    weighingScaleEnabled: false,
    labelPrinterEnabled: true,
    kitchenDisplayEnabled: false,
  },
  '8': {
    approvalRules: {
      discountEnabled: true,
      discountThresholdPercent: 10,
      refundEnabled: true,
      voidEnabled: true,
      settingsEnabled: true,
    },
    firstStaff: {
      name: 'Riya Sharma',
      phone: '+919820000000',
      accessLevel: 'cashier',
      defaultShift: 'morning',
    },
    openingFloatPerCounter: 5000,
    endOfDayReminder: '21:30',
    autoClockOutHours: '8',
  },
} as const

function tenantRow(data: unknown, step = 0, completedAt: Date | null = null) {
  return {
    onboarding_data: data,
    onboarding_step: step,
    onboarding_completed_at: completedAt,
    // Business identity is read from the tenant row now, not the JSON blob.
    business_name: 'Example Retail Private Limited',
    trade_name: 'Example Store',
    gst_status: 'regular',
  }
}

describe('onboarding routes', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    tenantsFindFirstMock.mockReset()
    tenantsUpdateMock.mockReset()
    membershipFindFirstMock.mockReset().mockImplementation(({ where }: { where: { role?: string } }) => ({
      role: where.role,
      tenant_id: 'tenant-real',
    }))
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { operatorContext } = await import('../../src/middleware/operatorContext')
    const { default: onboardingRouter } = await import('../../src/routes/onboarding')
    const app = express()
    app.use(express.json())
    app.use('/onboarding', authMiddleware, operatorContext, onboardingRouter)
    return app
  }

  it('returns the authenticated tenant draft and resumes the same server-derived step after reload', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow({ '1': stepFixtures['1'] }, 7))
    const app = await buildApp()

    const first = await request(app)
      .get('/onboarding')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
    const reloaded = await request(app)
      .get('/onboarding')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(first.status).toBe(200)
    expect(reloaded.body).toEqual(first.body)
    expect(first.body.currentStep).toBe(1)
    expect(first.body.completed).toBe(false)
    expect(first.body.data['1'].trialPlan).toBe('growth')

    const { forTenant } = await import('../../src/db/tenantClient')
    // authMiddleware verifies the live membership before the route reads the
    // tenant draft, so each request enters the tenant client twice.
    expect(forTenant).toHaveBeenCalledTimes(4)
    expect(forTenant).toHaveBeenNthCalledWith(1, 'tenant-real')
    expect(forTenant).toHaveBeenNthCalledWith(2, 'tenant-real')
    expect(forTenant).toHaveBeenNthCalledWith(3, 'tenant-real')
    expect(forTenant).toHaveBeenNthCalledWith(4, 'tenant-real')
  })

  it('lets an owner save the next strict step and derives progress from persisted data', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow({}))
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) =>
      tenantRow(data.onboarding_data, data.onboarding_step),
    )
    const app = await buildApp()

    const response = await request(app)
      .put('/onboarding/steps/1')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send(stepFixtures['1'])

    expect(response.status).toBe(200)
    expect(response.body.currentStep).toBe(1)
    expect(tenantsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-real' },
        data: expect.objectContaining({
          onboarding_step: 1,
          onboarding_data: { '1': stepFixtures['1'] },
        }),
      }),
    )
  })

  it.each(['manager', 'cashier'] as const)('denies %s mutation while preserving the stored draft', async (role) => {
    const app = await buildApp()
    const stepResponse = await request(app)
      .put('/onboarding/steps/1')
      .set('Authorization', `Bearer ${tokenFor(role)}`)
      .send(stepFixtures['1'])
    const completionResponse = await request(app)
      .post('/onboarding/complete')
      .set('Authorization', `Bearer ${tokenFor(role)}`)
      .send({})

    expect(stepResponse.status).toBe(403)
    expect(completionResponse.status).toBe(403)
    expect(tenantsFindFirstMock).not.toHaveBeenCalled()
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated, malformed, skipped, and forged cross-tenant step requests', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow({}))
    const app = await buildApp()

    const unauthenticated = await request(app).get('/onboarding')
    const badStep = await request(app)
      .put('/onboarding/steps/9')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send(stepFixtures['1'])
    const badBody = await request(app)
      .put('/onboarding/steps/1')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ trialPlan: '' })
    const forgedTenant = await request(app)
      .put('/onboarding/steps/1')
      .set('Authorization', `Bearer ${tokenFor('owner', 'tenant-real')}`)
      .send({ ...stepFixtures['1'], tenantId: 'tenant-other', role: 'owner', adminPin: '1234' })
    // Step 2 no longer exists — GST moved to signup.
    const removedStep = await request(app)
      .put('/onboarding/steps/2')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ gstStatus: 'regular' })
    // A deferred step while the required step is unsaved.
    const skipped = await request(app)
      .put('/onboarding/steps/3')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send(stepFixtures['3'])

    expect(unauthenticated.status).toBe(401)
    expect(badStep.status).toBe(400)
    expect(badBody.status).toBe(400)
    expect(forgedTenant.status).toBe(400)
    expect(removedStep.status).toBe(400)
    expect(skipped.status).toBe(409)
    expect(tenantsUpdateMock).not.toHaveBeenCalled()

    const { forTenant } = await import('../../src/db/tenantClient')
    expect(forTenant).toHaveBeenCalledWith('tenant-real')
    expect(forTenant).not.toHaveBeenCalledWith('tenant-other')
  })

  it('rejects incomplete completion without changing the stored completion timestamp', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow({}, 0))
    const app = await buildApp()

    const response = await request(app)
      .post('/onboarding/complete')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({})

    expect(response.status).toBe(409)
    expect(response.body.missingSteps).toEqual([1])
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
  })

  it('completes the trimmed required setup alone and reports the deferred steps as pending', async () => {
    const trimmed = { '1': stepFixtures['1'] }
    tenantsFindFirstMock.mockResolvedValue(tenantRow(trimmed, 1))
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) =>
      tenantRow(trimmed, data.onboarding_step, data.onboarding_completed_at),
    )
    const app = await buildApp()

    const response = await request(app)
      .post('/onboarding/complete')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({})

    expect(response.status).toBe(200)
    expect(response.body.completed).toBe(true)
    expect(response.body.requiredSteps).toEqual([1])
    expect(response.body.requiredStepsComplete).toBe(true)
    expect(response.body.pendingSteps).toEqual([3, 4, 5, 6, 7, 8])
    expect(response.body.summary.storeName).toBeNull()
    expect(response.body.summary.billingCounters).toBeNull()
  })

  it('accepts a deferred step after completion but refuses to reopen a required one', async () => {
    const trimmed = { '1': stepFixtures['1'] }
    tenantsFindFirstMock.mockResolvedValue(tenantRow(trimmed, 1, new Date('2026-01-01T00:00:00Z')))
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) =>
      tenantRow(data.onboarding_data, data.onboarding_step, new Date('2026-01-01T00:00:00Z')),
    )
    const app = await buildApp()

    const deferred = await request(app)
      .put('/onboarding/steps/7')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send(stepFixtures['7'])
    const required = await request(app)
      .put('/onboarding/steps/1')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send(stepFixtures['1'])

    expect(deferred.status).toBe(200)
    expect(deferred.body.pendingSteps).toEqual([3, 4, 5, 6, 8])
    expect(required.status).toBe(409)
  })

  it('refuses a deferred step while a required step is still missing', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow({}, 0))
    const app = await buildApp()

    const response = await request(app)
      .put('/onboarding/steps/7')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send(stepFixtures['7'])

    expect(response.status).toBe(409)
    expect(response.body.nextStep).toBe(1)
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
  })

  it('rejects a browser-forged completed flag instead of treating it as authority', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow(stepFixtures, 8))
    const app = await buildApp()

    const response = await request(app)
      .post('/onboarding/complete')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ completed: true })

    expect(response.status).toBe(400)
    expect(tenantsFindFirstMock).not.toHaveBeenCalled()
    expect(tenantsUpdateMock).not.toHaveBeenCalled()
  })

  it('completes all eight persisted steps with a server timestamp and server-derived summary', async () => {
    tenantsFindFirstMock.mockResolvedValue(tenantRow(stepFixtures, 3))
    tenantsUpdateMock.mockImplementation(async ({ data }: { data: any }) =>
      tenantRow(stepFixtures, data.onboarding_step, data.onboarding_completed_at),
    )
    const app = await buildApp()

    const response = await request(app)
      .post('/onboarding/complete')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({})

    expect(response.status).toBe(200)
    expect(response.body.completed).toBe(true)
    expect(response.body.currentStep).toBe(8)
    expect(response.body.completedAt).toMatch(/^20\d{2}-/)
    expect(response.body.summary).toEqual({
      businessName: 'Example Store',
      storeName: 'Bandra Flagship',
      trialPlan: 'growth',
      billingCounters: '2',
      gstStatus: 'regular',
    })
    expect(tenantsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-real' },
        data: expect.objectContaining({
          onboarding_step: 8,
          onboarding_completed_at: expect.any(Date),
        }),
      }),
    )
  })

  it('source never selects tenant scope from body, params, or query', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(path.join(__dirname, '../../src/routes/onboarding.ts'), 'utf8')

    expect(source).not.toMatch(/req\.body\.tenantId/)
    expect(source).not.toMatch(/req\.params\.tenantId/)
    expect(source).not.toMatch(/req\.query\.tenantId/)
  })
})
