import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attemptsFindFirst: vi.fn(),
  subscriptionsFindFirst: vi.fn(),
  subscriptionsUpsert: vi.fn(),
  fetchPlan: vi.fn(),
  fetchSubscription: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  attemptsCreate: vi.fn(),
  attemptsUpdate: vi.fn(),
  subscriptionsUpdate: vi.fn(),
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
      upsert: mocks.subscriptionsUpsert,
      update: mocks.subscriptionsUpdate,
    },
  })),
  forTenantTransaction: vi.fn(),
}))

vi.mock('../../src/services/razorpay', () => ({
  RazorpayRequestError: class RazorpayRequestError extends Error {},
  getRazorpayConfig: vi.fn(() => ({ keyId: 'rzp_test_key' })),
  fetchRazorpayPlan: mocks.fetchPlan,
  fetchRazorpaySubscription: mocks.fetchSubscription,
  createRazorpaySubscription: mocks.createSubscription,
  findRazorpaySubscriptionByAttemptId: vi.fn(),
  cancelRazorpaySubscription: mocks.cancelSubscription,
  verifyRazorpayCheckoutSignature: vi.fn(),
  unixSecondsToDate: vi.fn(() => null),
}))

const attempt = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: 'tenant-1',
  idempotency_key: '22222222-2222-4222-8222-222222222222',
  provider_subscription_id: 'sub_unpaid',
  provider_plan_id: 'plan_starter_annual',
  region: 'IN',
  plan_key: 'starter',
  billing_cycle: 'annual',
  currency: 'INR',
  base_amount_minor: 812_542n,
  tax_amount_minor: 146_258n,
  total_amount_minor: 958_800n,
  tax_rate_bps: 1_800,
  status: 'created',
}

const unpaidSubscription = {
  id: '33333333-3333-4333-8333-333333333333',
  tenant_id: 'tenant-1',
  attempt_id: attempt.id,
  provider_subscription_id: attempt.provider_subscription_id,
  plan_key: attempt.plan_key,
  billing_cycle: attempt.billing_cycle,
  region: attempt.region,
  status: 'created',
  entitlement_status: 'blocked',
  last_payment_id: null,
}

describe('subscription checkout recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([{
      key: 'starter',
      includedStores: 2,
      region: 'IN',
      currency: 'INR',
      name: 'Starter',
      description: 'Test plan',
      popular: false,
      features: [],
      monthly: { amountMinor: 79_900, taxRateBps: 1_800, providerPlanId: 'plan_starter_monthly' },
      annual: { amountMinor: 958_800, taxRateBps: 1_800, providerPlanId: 'plan_starter_annual' },
    }])
    mocks.fetchPlan.mockResolvedValue({
      id: 'plan_starter_annual',
      item: { amount: 958_800, currency: 'INR' },
    })
    mocks.fetchSubscription.mockResolvedValue({
      id: attempt.provider_subscription_id,
      plan_id: attempt.provider_plan_id,
      status: 'created',
    })
    mocks.attemptsFindFirst.mockImplementation(async ({ where }: any) => {
      if (where.idempotency_key) return null
      if (where.id === attempt.id) return attempt
      return null
    })
    mocks.subscriptionsFindFirst.mockResolvedValue(unpaidSubscription)
    mocks.attemptsUpdate.mockImplementation(async ({ data }: any) => ({ ...attempt, ...data }))
    mocks.subscriptionsUpdate.mockImplementation(async ({ data }: any) => ({ ...unpaidSubscription, ...data }))
  })

  it('resumes an unpaid created subscription when the browser returns with a new idempotency key', async () => {
    const { createSubscription } = await import('../../src/services/billing')

    const result = await createSubscription('tenant-1', {
      planKey: 'starter',
      billingCycle: 'annual',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    })

    expect(result).toMatchObject({
      attemptId: attempt.id,
      razorpaySubscriptionId: attempt.provider_subscription_id,
      status: 'created',
      planKey: 'starter',
      billingCycle: 'annual',
    })
    expect(mocks.fetchSubscription).toHaveBeenCalledWith(attempt.provider_subscription_id)
    expect(mocks.createSubscription).not.toHaveBeenCalled()
    expect(mocks.subscriptionsUpsert).not.toHaveBeenCalled()
  })

  it('cancels and supersedes an unpaid checkout before creating a different plan checkout', async () => {
    const replacementAttempt = {
      ...attempt,
      id: '55555555-5555-4555-8555-555555555555',
      idempotency_key: '66666666-6666-4666-8666-666666666666',
      plan_key: 'starter',
      billing_cycle: 'monthly',
      provider_plan_id: 'plan_starter_monthly',
      provider_subscription_id: null,
      status: 'creating',
    }
    const replacementProvider = {
      id: 'sub_replacement',
      plan_id: 'plan_starter_monthly',
      status: 'created',
    }
    mocks.fetchPlan.mockResolvedValue({ id: 'plan_starter_monthly', item: { amount: 79_900, currency: 'INR' } })
    mocks.cancelSubscription.mockResolvedValue({
      id: attempt.provider_subscription_id,
      plan_id: attempt.provider_plan_id,
      status: 'cancelled',
    })
    mocks.attemptsCreate.mockResolvedValue(replacementAttempt)
    mocks.createSubscription.mockResolvedValue(replacementProvider)
    mocks.attemptsUpdate
      .mockResolvedValueOnce({ ...attempt, status: 'expired' })
      .mockResolvedValueOnce({ ...replacementAttempt, provider_subscription_id: replacementProvider.id, status: 'created' })
    mocks.subscriptionsUpsert.mockResolvedValue({ ...unpaidSubscription, provider_subscription_id: replacementProvider.id })

    const { createSubscription } = await import('../../src/services/billing')
    const result = await createSubscription('tenant-1', {
      planKey: 'starter',
      billingCycle: 'monthly',
      idempotencyKey: replacementAttempt.idempotency_key,
    })

    expect(mocks.cancelSubscription).toHaveBeenCalledWith(attempt.provider_subscription_id, false)
    expect(mocks.subscriptionsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: unpaidSubscription.id },
      data: expect.objectContaining({ status: 'cancelled', entitlement_status: 'blocked' }),
    }))
    expect(mocks.createSubscription).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan_starter_monthly',
      billingCycle: 'monthly',
    }))
    expect(result).toMatchObject({ razorpaySubscriptionId: replacementProvider.id, planKey: 'starter', billingCycle: 'monthly' })
  })

  it('preserves a previous checkout when Razorpay reports that it became active', async () => {
    mocks.fetchPlan.mockResolvedValue({ id: 'plan_starter_monthly', item: { amount: 79_900, currency: 'INR' } })
    mocks.fetchSubscription.mockResolvedValue({
      id: attempt.provider_subscription_id,
      plan_id: attempt.provider_plan_id,
      status: 'active',
    })

    const { createSubscription } = await import('../../src/services/billing')
    await expect(createSubscription('tenant-1', {
      planKey: 'starter',
      billingCycle: 'monthly',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    })).rejects.toMatchObject({
      status: 409,
      message: 'Your previous payment is active. Refresh the page to continue with that subscription.',
    })

    expect(mocks.cancelSubscription).not.toHaveBeenCalled()
    expect(mocks.createSubscription).not.toHaveBeenCalled()
    expect(mocks.subscriptionsUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'active', entitlement_status: 'active' }),
    }))
  })
})
