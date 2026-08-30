import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  entitlementSummary: vi.fn(),
  getPlans: vi.fn(),
  getPlan: vi.fn(),
  toPlanOption: vi.fn(),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { findFirst: vi.fn(async () => ({ country: 'IN' })) },
    $queryRaw: mocks.queryRaw,
  })),
}))

vi.mock('../../src/middleware/requireRole', () => ({
  requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}))

vi.mock('../../src/services/billing', () => ({
  billingMode: vi.fn(() => 'live'),
  cancelSubscription: vi.fn(),
  createSubscription: vi.fn(),
  getBillingStatus: vi.fn(),
  regionForCountry: vi.fn(() => 'IN'),
  verifySubscription: vi.fn(),
}))

vi.mock('../../src/services/entitlements', () => ({
  entitlementStatusFields: vi.fn(() => ({})),
  getEntitlementSummary: mocks.entitlementSummary,
}))

vi.mock('../../src/services/billingCatalog', () => ({
  canonicalBillingRegion: vi.fn((region: string) => region),
  getPlan: mocks.getPlan,
  getPlans: mocks.getPlans,
  toPlanOption: mocks.toPlanOption,
}))

const privateOffer = {
  id: '3d91bf18-3111-40de-bb15-c9b3f37e5f58',
  base_plan_key: 'starter',
  billing_cycle: 'monthly',
  currency: 'INR',
  negotiated_base_amount_minor: 16_864,
  tax_amount_minor: 3_036,
  total_amount_minor: 19_900,
  tax_rate_bps: 1_800,
  included_location_count: 2,
  included_register_count: 3,
  included_user_count: 5,
  trial_days: 1,
  trial_duration_minutes: 9,
  latest_activation_at: new Date(Date.now() + 60_000),
}

const basePlan = {
  key: 'starter',
  name: 'Starter',
  description: 'Test plan',
  currency: 'INR',
  entitlements: { maxLocations: 2, maxActiveRegisters: 3, maxActiveUsers: 5 },
  features: [],
  addons: [],
  monthly: { amountMinor: 79_900, taxRateBps: 1_800, providerPlanId: 'plan_starter_monthly' },
  annual: { amountMinor: 958_800, taxRateBps: 1_800, providerPlanId: 'plan_starter_annual' },
}

describe('billing plan selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPlan.mockReturnValue(basePlan)
    mocks.getPlans.mockReturnValue([{ ...basePlan, key: 'growth' }])
    mocks.toPlanOption.mockImplementation((plan: any) => ({
      ...plan,
      providerConfigured: { monthly: Boolean(plan.monthly?.providerPlanId), annual: Boolean(plan.annual?.providerPlanId) },
    }))
    mocks.entitlementSummary.mockResolvedValue({ access: { accessAllowed: false } })
  })

  it('returns the valid private offer even when the entitlement projection is unavailable', async () => {
    mocks.entitlementSummary.mockRejectedValueOnce(new Error('read model unavailable'))
    mocks.queryRaw.mockResolvedValueOnce([privateOffer])
    const { default: billingRouter } = await import('../../src/routes/billing')
    const app = express()
    app.use((req: any, _res, next) => {
      req.user = { tenantId: 'tenant-1', role: 'owner' }
      next()
    })
    app.use('/billing', billingRouter)

    const response = await request(app).get('/billing/plans?region=IN')

    expect(response.status).toBe(200)
    expect(response.body.privateOfferId).toBe(privateOffer.id)
    expect(response.body.billingCycle).toBe('monthly')
    expect(response.body.plans[0].monthly.totalAmountMinor).toBe(19_900)
    expect(response.body.plans[0].monthly.baseAmountMinor).toBe(16_864)
    expect(response.body.plans[0].monthly.taxAmountMinor).toBe(3_036)
  })
})
