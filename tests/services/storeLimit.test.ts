import { describe, it, expect, vi } from 'vitest'
import { storeAllowance, storeLimitMessage } from '../../src/services/storeLimit'
import { includedStoresForPlan } from '../../src/services/billingCatalog'

function tx(activeStores: number, subscription: unknown) {
  return {
    stores: { count: vi.fn(async () => activeStores) },
    billing_subscriptions: { findFirst: vi.fn(async () => subscription) },
  }
}

describe('storeAllowance (Phase 8 task 12)', () => {
  it('Test 1: a plan allowance plus purchased add-ons is the limit', async () => {
    const allowance = await storeAllowance(
      tx(2, { included_store_count: 3, additional_store_count: 2 }),
      'tenant-1',
    )
    expect(allowance).toEqual({
      used: 2,
      limit: 5,
      canAddStore: true,
      includedInPlan: 3,
      additionalPurchased: 2,
    })
  })

  it('Test 2: at the limit, another shop is refused', async () => {
    const allowance = await storeAllowance(
      tx(3, { included_store_count: 3, additional_store_count: 0 }),
      'tenant-1',
    )
    expect(allowance.canAddStore).toBe(false)
  })

  it('Test 3: no subscription means one shop, not unlimited', async () => {
    // A tenant mid-signup or on a lapsed plan keeps the shop they have and
    // cannot open more. Defaulting to unlimited would make the limit
    // unenforceable exactly when billing is broken — which is when it matters.
    const allowance = await storeAllowance(tx(1, null), 'tenant-1')
    expect(allowance).toMatchObject({ limit: 1, canAddStore: false })
  })

  it('Test 4: only ACTIVE shops consume the allowance', async () => {
    // An owner who closes a shop must be able to open its replacement. Counting
    // deactivated outlets would have them paying for a shop that is not
    // trading and blocked from opening the one that is.
    const client = tx(1, { included_store_count: 2, additional_store_count: 0 })
    const allowance = await storeAllowance(client, 'tenant-1')

    expect(client.stores.count).toHaveBeenCalledWith({ where: { is_active: true } })
    expect(allowance.canAddStore).toBe(true)
  })

  it('Test 5: the refusal names the numbers and says what to do', async () => {
    const allowance = await storeAllowance(
      tx(3, { included_store_count: 3, additional_store_count: 0 }),
      'tenant-1',
    )
    const message = storeLimitMessage(allowance)

    // A bare "limit reached" leaves an owner unsure whether it is a bug.
    expect(message).toContain('3')
    expect(message).toMatch(/upgrade/i)
  })

  it('Test 6: the single-shop message is not pluralised', async () => {
    const allowance = await storeAllowance(tx(1, null), 'tenant-1')
    expect(storeLimitMessage(allowance)).toContain('1 store and')
  })
})

describe('includedStoresForPlan', () => {
  it('Test 7: known plans carry their tier allowance', () => {
    expect(includedStoresForPlan('starter')).toBe(2)
    expect(includedStoresForPlan('growth')).toBe(5)
    expect(includedStoresForPlan('pro')).toBe(6)
    expect(includedStoresForPlan('pro', 'INTL')).toBe(15)
    expect(includedStoresForPlan('professional', 'US')).toBe(5)
  })

  it('Test 8: an unknown plan defaults DOWN to one shop', () => {
    // Defaulting up would grant unlimited outlets on a typo'd plan key and
    // produce unbilled shops nobody notices for months. Defaulting down
    // produces a support conversation, which is the cheaper failure.
    expect(includedStoresForPlan('does-not-exist')).toBe(1)
  })
})
