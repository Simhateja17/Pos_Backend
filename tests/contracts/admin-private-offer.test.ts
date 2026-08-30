import { describe, expect, it } from 'vitest'
import { AdminPrivateOfferSchema } from '../../src/contracts/schemas/admin'

const validOffer = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  basePlanKey: 'starter',
  billingCycle: 'monthly',
  negotiatedBaseAmountMinor: 79_900,
  includedLocations: 1,
  includedRegisters: 1,
  includedUsers: 1,
  additionalLocationUnitAmountMinor: 29_900,
  additionalRegisterUnitAmountMinor: 19_900,
  additionalUserUnitAmountMinor: 9_900,
  latestActivationAt: '2027-01-01T00:00:00.000Z',
  priceValidity: 'until_changed',
  fixedBillingCycles: null,
  internalReason: 'Retailer-specific negotiated offer',
}

describe('AdminPrivateOfferSchema trial duration', () => {
  it.each([5, 120, 14 * 1440])('accepts an exact %i-minute trial', (trialDurationMinutes) => {
    expect(AdminPrivateOfferSchema.safeParse({ ...validOffer, trialDurationMinutes }).success).toBe(true)
  })

  it.each([-1, 1.5, 525_601])('rejects invalid minute duration %s', (trialDurationMinutes) => {
    expect(AdminPrivateOfferSchema.safeParse({ ...validOffer, trialDurationMinutes }).success).toBe(false)
  })
})
