import { afterEach, describe, expect, it } from 'vitest'
import { calculateQuote, getPlan } from '../../src/services/billingCatalog'

const originalCatalog = process.env.BILLING_PLAN_CATALOG_JSON
const originalUsRate = process.env.US_SUBSCRIPTION_TAX_RATE_BPS

afterEach(() => {
  if (originalCatalog === undefined) delete process.env.BILLING_PLAN_CATALOG_JSON
  else process.env.BILLING_PLAN_CATALOG_JSON = originalCatalog
  if (originalUsRate === undefined) delete process.env.US_SUBSCRIPTION_TAX_RATE_BPS
  else process.env.US_SUBSCRIPTION_TAX_RATE_BPS = originalUsRate
})

describe('subscription quote calculation', () => {
  it('derives GST from an India tax-inclusive total without discounting the total', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([
      {
        key: 'growth', region: 'IN', currency: 'INR', name: 'Growth', description: 'Test', popular: true, features: [],
        monthly: { amountMinor: 199_900, taxRateBps: 1_800, providerPlanId: 'plan_test_growth_monthly' },
        annual: { amountMinor: 1_999_000, taxRateBps: 1_800, providerPlanId: 'plan_test_growth_annual' },
      },
    ])

    const plan = getPlan('IN', 'growth')!
    const quote = calculateQuote(plan, 'monthly')
    expect(quote.baseAmountMinor).toBe(169_407)
    expect(quote.taxAmountMinor).toBe(30_493)
    expect(quote.totalAmountMinor).toBe(199_900)
    expect(quote.taxMode).toBe('included')
  })

  it('keeps US tax separate and configurable', () => {
    process.env.BILLING_PLAN_CATALOG_JSON = JSON.stringify([
      {
        key: 'professional', region: 'US', currency: 'USD', name: 'Professional', description: 'Test', popular: true, features: [],
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
    process.env.BILLING_PLAN_CATALOG_JSON = '[{\\"key\\":\\"starter\\",\\"region\\":\\"IN\\",\\"currency\\":\\"INR\\",\\"name\\":\\"Starter\\",\\"description\\":\\"Test\\",\\"popular\\":false,\\"features\\":[],\\"monthly\\":{\\"amountMinor\\":99900},\\"annual\\":{\\"amountMinor\\":958800}}]'

    expect(getPlan('IN', 'starter')?.key).toBe('starter')
  })
})
