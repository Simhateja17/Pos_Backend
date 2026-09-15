import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attemptsFindFirst: vi.fn(),
  attemptsCreate: vi.fn(),
  attemptsUpdate: vi.fn(),
  subscriptionsFindFirst: vi.fn(),
  subscriptionsCreate: vi.fn(),
  subscriptionsUpdate: vi.fn(),
  txSubscriptionsUpdate: vi.fn(),
  txAttemptsUpdate: vi.fn(),
  fetchPlan: vi.fn(),
  fetchSubscription: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  summary: vi.fn(),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { findFirst: vi.fn(async () => ({ country: 'IN' })) },
    billing_subscription_attempts: {
      findFirst: mocks.attemptsFindFirst,
      create: mocks.attemptsCreate,
      update: mocks.attemptsUpdate,
    },
    billing_subscriptions: {
      findFirst: mocks.subscriptionsFindFirst,
      create: mocks.subscriptionsCreate,
      update: mocks.subscriptionsUpdate,
    },
  })),
  forTenantTransaction: vi.fn((_tenantId: string, fn: (tx: any) => Promise<any>) => fn({
    billing_subscriptions: { update: mocks.txSubscriptionsUpdate, findFirst: mocks.subscriptionsFindFirst },
    billing_subscription_attempts: { update: mocks.txAttemptsUpdate },
  })),
}))

vi.mock('../../src/services/razorpay', () => ({
  RazorpayRequestError: class RazorpayRequestError extends Error {},
  getRazorpayConfig: vi.fn(() => ({ keyId: 'rzp_test_key' })),
  fetchRazorpayPlan: mocks.fetchPlan,
  fetchRazorpaySubscription: mocks.fetchSubscription,
  createRazorpaySubscription: mocks.createSubscription,
  findRazorpaySubscriptionByAttemptId: vi.fn(async () => null),
  cancelRazorpaySubscription: mocks.cancelSubscription,
  listRazorpayInvoices: vi.fn(async () => []),
  verifyRazorpayCheckoutSignature: vi.fn(),
  unixSecondsToDate: vi.fn(() => null),
}))

vi.mock('../../src/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/entitlements')>()),
  getEntitlementSummary: mocks.summary,
}))

import { cancelPendingChange, changeSubscription, reconcilePlanSwitch } from '../../src/services/billing'

const limits = (locations: number) => ({
  maxLocations: locations, maxActiveUsers: 10, maxActiveRegisters: 5,
  monthlyPosTransactions: 'unlimited', monthlySalesOrders: 'unlimited', monthlyEcommerceOrders: 'unlimited',
  monthlyPurchaseOrders: 'unlimited', monthlyBills: 'unlimited', dailyApiCalls: 'unlimited', integrations: 0,
})

const catalog = [
  { key: 'starter', amount: 79_900, locations: 1 },
  { key: 'pro', amount: 199_900, locations: 5 },
].map(({ key, amount, locations }) => ({
  key, includedStores: locations, region: 'IN', currency: 'INR', name: key === 'pro' ? 'Pro' : 'Starter',
  description: 'Test plan', popular: false, features: [], entitlements: limits(locations), addons: [],
  monthly: { amountMinor: amount, taxRateBps: 1_800, providerPlanId: `plan_${key}_monthly` },
  annual: { amountMinor: amount * 12, taxRateBps: 1_800, providerPlanId: `plan_${key}_annual` },
}))

const periodEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)

function liveRow(planKey: 'starter' | 'pro', overrides: Record<string, unknown> = {}) {
  const plan = catalog.find((entry) => entry.key === planKey)!
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenant_id: 'tenant-1',
    provider_subscription_id: 'sub_live',
    plan_key: planKey,
    billing_cycle: 'monthly',
    currency: 'INR',
    total_amount_minor: BigInt(plan.monthly.amountMinor),
    status: 'active',
    entitlement_status: 'active',
    cancel_at_cycle_end: false,
    current_end_at: periodEnd,
    switch_pending: false,
    ...overrides,
  }
}

const input = (planKey: string) => ({ planKey, billingCycle: 'monthly' as const, idempotencyKey: '44444444-4444-4444-8444-444444444444' })

describe('plan changes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify(catalog)
    mocks.fetchPlan.mockImplementation(async (id: string) => {
      const plan = catalog.find((entry) => id.startsWith(`plan_${entry.key}_`))!
      return { id, item: { amount: id.endsWith('annual') ? plan.annual.amountMinor : plan.monthly.amountMinor, currency: 'INR' } }
    })
    mocks.attemptsCreate.mockImplementation(async ({ data }: any) => ({ id: '55555555-5555-4555-8555-555555555555', ...data }))
    mocks.attemptsUpdate.mockImplementation(async ({ data }: any) => ({ id: '55555555-5555-4555-8555-555555555555', plan_key: 'x', billing_cycle: 'monthly', currency: 'INR', ...data }))
    mocks.subscriptionsCreate.mockImplementation(async ({ data }: any) => ({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ...data }))
    mocks.createSubscription.mockResolvedValue({ id: 'sub_new', plan_id: 'plan', status: 'created', short_url: 'https://rzp.io/i/new' })
    mocks.summary.mockResolvedValue({ usage: { locations: 1, activeUsers: 2, activeRegisters: 1 } })
  })

  it('starts an upgrade immediately as a pending successor with a hosted checkout link', async () => {
    mocks.attemptsFindFirst.mockResolvedValue(null)
    mocks.subscriptionsFindFirst.mockImplementation(async ({ where }: any) => (where.switch_pending ? null : liveRow('starter')))

    const result = await changeSubscription('tenant-1', input('pro'))

    expect(result.kind).toBe('upgrade')
    expect(result.checkoutUrl).toBe('https://rzp.io/i/new')
    expect(mocks.createSubscription.mock.calls[0][0].startAt).toBeUndefined()
    expect(mocks.subscriptionsCreate.mock.calls[0][0].data).toMatchObject({
      plan_key: 'pro', switch_pending: true, switch_kind: 'upgrade', switch_starts_at: null, entitlement_status: 'blocked',
    })
  })

  it('schedules a downgrade to start when the current period ends', async () => {
    mocks.attemptsFindFirst.mockResolvedValue(null)
    mocks.subscriptionsFindFirst.mockImplementation(async ({ where }: any) => (where.switch_pending ? null : liveRow('pro')))

    const result = await changeSubscription('tenant-1', input('starter'))

    expect(result.kind).toBe('downgrade')
    expect(mocks.createSubscription.mock.calls[0][0].startAt).toBe(Math.floor(periodEnd.getTime() / 1000))
    expect(result.startsAt).toBe(periodEnd.toISOString())
  })

  it('refuses a downgrade the business has already outgrown', async () => {
    mocks.attemptsFindFirst.mockResolvedValue(null)
    mocks.subscriptionsFindFirst.mockImplementation(async ({ where }: any) => (where.switch_pending ? null : liveRow('pro')))
    mocks.summary.mockResolvedValue({ usage: { locations: 3, activeUsers: 2, activeRegisters: 1 } })

    await expect(changeSubscription('tenant-1', input('starter'))).rejects.toMatchObject({ status: 409 })
    expect(mocks.createSubscription).not.toHaveBeenCalled()
  })

  it('ends the old subscription before promoting an authorised upgrade', async () => {
    const old = liveRow('starter')
    mocks.subscriptionsFindFirst.mockResolvedValue(old)
    mocks.cancelSubscription.mockResolvedValue({ id: 'sub_live', status: 'cancelled' })

    await reconcilePlanSwitch('tenant-1', {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', switch_pending: true, status: 'active',
      switch_starts_at: null, replaces_subscription_id: old.id, attempt_id: null,
    })

    expect(mocks.cancelSubscription).toHaveBeenCalledWith('sub_live', false)
    const [first, second] = mocks.txSubscriptionsUpdate.mock.calls.map(([call]) => call)
    expect(first).toMatchObject({ where: { id: old.id }, data: { status: 'cancelled' } })
    expect(second).toMatchObject({ data: { switch_pending: false, entitlement_status: 'active' } })
  })

  it('does not promote an upgrade while the old subscription is still charging', async () => {
    const { RazorpayRequestError } = await import('../../src/services/razorpay')
    mocks.subscriptionsFindFirst.mockResolvedValue(liveRow('starter'))
    mocks.cancelSubscription.mockRejectedValue(new RazorpayRequestError(400, 'boom'))
    mocks.fetchSubscription.mockResolvedValue({ id: 'sub_live', status: 'active' })

    await expect(reconcilePlanSwitch('tenant-1', {
      id: 'b', switch_pending: true, status: 'active', switch_starts_at: null, replaces_subscription_id: 'a',
    })).rejects.toMatchObject({ status: 502 })
    expect(mocks.txSubscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('sets the old plan to end at cycle end once a downgrade is authorised, without promoting yet', async () => {
    const old = liveRow('pro')
    mocks.subscriptionsFindFirst.mockResolvedValue(old)
    mocks.cancelSubscription.mockResolvedValue({ id: 'sub_live', status: 'active' })

    await reconcilePlanSwitch('tenant-1', {
      id: 'b', switch_pending: true, status: 'authenticated', switch_starts_at: periodEnd, replaces_subscription_id: old.id,
    })

    expect(mocks.cancelSubscription).toHaveBeenCalledWith('sub_live', true)
    expect(mocks.subscriptionsUpdate.mock.calls[0][0]).toMatchObject({ where: { id: old.id }, data: { cancel_at_cycle_end: true } })
    expect(mocks.txSubscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('hands over to the authorised successor when the old subscription ends', async () => {
    const successor = { id: 'b', switch_pending: true, status: 'authenticated', attempt_id: null }
    mocks.subscriptionsFindFirst.mockResolvedValue(successor)

    await reconcilePlanSwitch('tenant-1', liveRow('pro', { status: 'cancelled' }))

    expect(mocks.txSubscriptionsUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'b' }, data: { switch_pending: false, entitlement_status: 'grace' },
    })
  })

  it('will not discard a change that is already authorised', async () => {
    mocks.subscriptionsFindFirst.mockResolvedValue({ id: 'b', switch_pending: true, status: 'authenticated' })
    await expect(cancelPendingChange('tenant-1')).rejects.toMatchObject({ status: 409 })
    expect(mocks.cancelSubscription).not.toHaveBeenCalled()
  })
})
