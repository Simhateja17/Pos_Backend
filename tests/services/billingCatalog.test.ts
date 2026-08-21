import { afterEach, describe, expect, it } from 'vitest'
import { calculateQuote, getPlan, getPlans } from '../../src/services/billingCatalog'

const originalCatalog = process.env.BILLING_PLAN_CATALOG_JSON
const originalInternationalRate = process.env.INTERNATIONAL_SUBSCRIPTION_TAX_RATE_BPS
const originalUsRate = process.env.US_SUBSCRIPTION_TAX_RATE_BPS

afterEach(() => {
  if (originalCatalog === undefined) delete process.env.BILLING_PLAN_CATALOG_JSON
  else process.env.BILLING_PLAN_CATALOG_JSON = originalCatalog
  if (originalUsRate === undefined) delete process.env.US_SUBSCRIPTION_TAX_RATE_BPS
  else process.env.US_SUBSCRIPTION_TAX_RATE_BPS = originalUsRate
  if (originalInternationalRate === undefined) delete process.env.INTERNATIONAL_SUBSCRIPTION_TAX_RATE_BPS
  else process.env.INTERNATIONAL_SUBSCRIPTION_TAX_RATE_BPS = originalInternationalRate
})

describe('subscription quote calculation', () => {
  it('exposes the three India plans from the pricing brief', () => {
    const plans = getPlans('IN')

    expect(plans.map((plan) => plan.key)).toEqual(['starter', 'growth', 'pro'])
    expect(plans.map((plan) => plan.monthly.amountMinor)).toEqual([79_900, 149_900, 299_900])
    expect(plans.map((plan) => plan.annual.amountMinor)).toEqual([958_800, 1_798_800, 3_598_800])
    expect(plans.map((plan) => plan.includedStores)).toEqual([2, 5, 6])
    expect(plans.map((plan) => plan.entitlements.maxActiveUsers)).toEqual([5, 15, 10])
    expect(plans.map((plan) => plan.entitlements.maxActiveRegisters)).toEqual([3, 8, 6])
    expect(plans.every((plan) => plan.entitlements.monthlyPosTransactions === 'unlimited')).toBe(true)
    expect(plans.every((plan) => plan.features.some((feature) => /ML reorder intelligence/i.test(feature)))).toBe(true)
    expect(plans.find((plan) => plan.key === 'pro')?.addons).toEqual([
      { key: 'location', label: 'Additional location', unitAmountMinor: 29_900 },
      { key: 'register', label: 'Additional register', unitAmountMinor: 19_900 },
      { key: 'user', label: 'Additional user', unitAmountMinor: 9_900 },
    ])
  })

  it('derives GST from an India tax-inclusive total without discounting the total', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([
      {
        key: 'pro', includedStores: 6, region: 'IN', currency: 'INR', name: 'Pro', description: 'Test', popular: true, features: [],
        monthly: { amountMinor: 199_900, taxRateBps: 1_800, providerPlanId: 'plan_test_pro_monthly' },
        annual: { amountMinor: 1_999_000, taxRateBps: 1_800, providerPlanId: 'plan_test_pro_annual' },
      },
    ])

    const plan = getPlan('IN', 'pro')!
    const quote = calculateQuote(plan, 'monthly')
    expect(quote.baseAmountMinor).toBe(169_407)
    expect(quote.taxAmountMinor).toBe(30_493)
    expect(quote.totalAmountMinor).toBe(199_900)
    expect(quote.taxMode).toBe('included')
  })

  it('keeps international tax separate and configurable', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([
      {
        key: 'growth', includedStores: 5, region: 'INTL', currency: 'USD', name: 'Growth', description: 'Test', popular: true, features: [],
        monthly: { amountMinor: 9_900, providerPlanId: 'plan_test_growth_monthly' },
        annual: { amountMinor: 99_000, providerPlanId: 'plan_test_growth_annual' },
      },
    ])
    process.env.US_SUBSCRIPTION_TAX_RATE_BPS = '825'

    const quote = calculateQuote(getPlan('US', 'growth')!, 'monthly')
    expect(quote.baseAmountMinor).toBe(9_900)
    expect(quote.taxAmountMinor).toBe(817)
    expect(quote.totalAmountMinor).toBe(10_717)
    expect(quote.taxMode).toBe('exclusive')
  })

  it('accepts the escaped dotenv representation emitted by the old plan script', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = '[{\\"key\\":\\"starter\\",\\"includedStores\\":1,\\"region\\":\\"IN\\",\\"currency\\":\\"INR\\",\\"name\\":\\"Starter\\",\\"description\\":\\"Test\\",\\"popular\\":false,\\"features\\":[],\\"monthly\\":{\\"amountMinor\\":99900},\\"annual\\":{\\"amountMinor\\":958800}}]'

    expect(getPlan('IN', 'starter')?.key).toBe('starter')
  })

  it('keeps the legacy US region alias on the international catalogue', () => {
    expect(getPlans('US').map((plan) => plan.key)).toEqual(['starter', 'growth', 'pro'])
    expect(getPlan('US', 'growth')?.currency).toBe('USD')
    expect(getPlan('US', 'standard')).toBeUndefined()
  })
})
