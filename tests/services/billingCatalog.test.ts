import { afterEach, describe, expect, it } from 'vitest'
import { calculateQuote, getPlan, getPlans } from '../../src/services/billingCatalog'

const originalCatalog = process.env.BILLING_PLAN_CATALOG_JSON
const originalUsRate = process.env.US_SUBSCRIPTION_TAX_RATE_BPS

afterEach(() => {
  if (originalCatalog === undefined) delete process.env.BILLING_PLAN_CATALOG_JSON
  else process.env.BILLING_PLAN_CATALOG_JSON = originalCatalog
  if (originalUsRate === undefined) delete process.env.US_SUBSCRIPTION_TAX_RATE_BPS
  else process.env.US_SUBSCRIPTION_TAX_RATE_BPS = originalUsRate
})

describe('subscription quote calculation', () => {
  it('exposes exactly the four India plans and the supplied annual-billing prices', () => {
    const plans = getPlans('IN')

    expect(plans.map((plan) => plan.key)).toEqual(['free', 'standard', 'professional', 'premium'])
    expect(plans.map((plan) => plan.annual.amountMinor)).toEqual([0, 778_800, 1_558_800, 2_518_800])
    expect(plans.map((plan) => plan.entitlements.maxActiveUsers)).toEqual([1, 3, 10, 15])
    expect(plans.map((plan) => plan.entitlements.maxActiveRegisters)).toEqual([1, 1, 3, 5])
    expect(plans[0].entitlements.monthlyPosTransactions).toBe(50)
    expect(plans.slice(1).every((plan) => plan.entitlements.monthlyPosTransactions === 'unlimited')).toBe(true)
    expect(plans.flatMap((plan) => plan.features).join(' ')).not.toMatch(/loyalty|whatsapp|ecommerce|zoho|custom report/i)
  })

  it('derives GST from an India tax-inclusive total without discounting the total', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([
      {
        key: 'professional', includedStores: 3, region: 'IN', currency: 'INR', name: 'Professional', description: 'Test', popular: true, features: [],
        monthly: { amountMinor: 199_900, taxRateBps: 1_800, providerPlanId: 'plan_test_professional_monthly' },
        annual: { amountMinor: 1_999_000, taxRateBps: 1_800, providerPlanId: 'plan_test_professional_annual' },
      },
    ])

    const plan = getPlan('IN', 'professional')!
    const quote = calculateQuote(plan, 'monthly')
    expect(quote.baseAmountMinor).toBe(169_407)
    expect(quote.taxAmountMinor).toBe(30_493)
    expect(quote.totalAmountMinor).toBe(199_900)
    expect(quote.taxMode).toBe('included')
  })

  it('keeps US tax separate and configurable', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([
      {
        key: 'professional', includedStores: 5, region: 'US', currency: 'USD', name: 'Professional', description: 'Test', popular: true, features: [],
        monthly: { amountMinor: 7_900, providerPlanId: 'plan_test_professional_monthly' },
        annual: { amountMinor: 79_000, providerPlanId: 'plan_test_professional_annual' },
      },
    ])
    process.env.US_SUBSCRIPTION_TAX_RATE_BPS = '825'

    const quote = calculateQuote(getPlan('US', 'professional')!, 'monthly')
    expect(quote.baseAmountMinor).toBe(7_900)
    expect(quote.taxAmountMinor).toBe(652)
    expect(quote.totalAmountMinor).toBe(8_552)
    expect(quote.taxMode).toBe('exclusive')
  })

  it('accepts the escaped dotenv representation emitted by the old plan script', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = '[{\\"key\\":\\"starter\\",\\"includedStores\\":1,\\"region\\":\\"IN\\",\\"currency\\":\\"INR\\",\\"name\\":\\"Starter\\",\\"description\\":\\"Test\\",\\"popular\\":false,\\"features\\":[],\\"monthly\\":{\\"amountMinor\\":99900},\\"annual\\":{\\"amountMinor\\":958800}}]'

    expect(getPlan('IN', 'standard')?.key).toBe('standard')
  })

  it('keeps the US catalogue independent from India plan replacement', () => {
    expect(getPlans('US').map((plan) => plan.key)).toEqual(['essentials', 'professional'])
    expect(getPlan('US', 'professional')?.currency).toBe('USD')
    expect(getPlan('US', 'standard')).toBeUndefined()
  })
})
