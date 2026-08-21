import { describe, expect, it } from 'vitest'
import {
  decideEntitlement,
  ENTITLEMENT_VERSION,
  effectiveEntitlementLimits,
  reservePosTransaction,
  snapshotForPlan,
  snapshotFromStoredRow,
} from '../../src/services/entitlements'
import { trialAccessForRow } from '../../src/services/billingAccess'

function fakeTransaction(initialUsed = 0, posLimit = 50) {
  let used = initialUsed
  const eventKeys = new Set<string>()
  const deletedEvents: string[] = []

  const tx = {
    tenants: {
      findFirst: async () => ({ country: 'IN', timezone: 'Asia/Kolkata' }),
    },
    stores: { count: async () => 1 },
    staff_members: { count: async () => 1 },
    terminals: { count: async () => 1 },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(strings).join(' ')
      if (query.includes('FROM public.billing_subscriptions')) return []
      if (query.includes('FROM public.billing_trials')) {
        return [{
          plan_key: 'free',
          region: 'IN',
          status: 'active',
          started_at: new Date('2026-08-01T00:00:00.000Z'),
          ends_at: null,
          entitlement_snapshot: {
            version: 'india-mvp-04-v1',
            planKey: 'free',
            region: 'IN',
            limits: {
              maxLocations: 1,
              maxActiveUsers: 1,
              maxActiveRegisters: 1,
              monthlyPosTransactions: posLimit,
              monthlySalesOrders: 50,
              monthlyEcommerceOrders: 50,
              monthlyPurchaseOrders: 20,
              monthlyBills: 20,
              dailyApiCalls: 1_500,
              integrations: 0,
            },
          },
        }]
      }
      if (query.includes('FROM public.entitlement_usage_counters')) {
        return [{ business_month: '2026-08-01', used_count: used }]
      }
      if (query.includes('INSERT INTO public.entitlement_usage_events')) {
        const sourceKey = String(values[5])
        if (eventKeys.has(sourceKey)) return []
        eventKeys.add(sourceKey)
        return [{ id: `event-${sourceKey}` }]
      }
      if (query.includes('INSERT INTO public.entitlement_usage_counters')) {
        if (used >= posLimit) return []
        used += 1
        return [{ used_count: used }]
      }
      return []
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(strings).join(' ')
      if (query.includes('DELETE FROM public.entitlement_usage_events')) deletedEvents.push(String(values[3]))
      return 1
    },
  }

  return { tx, getUsed: () => used, eventKeys, deletedEvents }
}

describe('entitlement projection and enforcement', () => {
  it('resolves an unknown plan downward to Starter and never trusts malformed stored limits', () => {
    const unknown = snapshotForPlan('IN', 'does-not-exist')
    expect(unknown.planKey).toBe('starter')
    expect(unknown.limits.maxActiveUsers).toBe(5)
    expect(unknown.limits.monthlyPosTransactions).toBe('unlimited')

    const malformed = snapshotFromStoredRow({
      plan_key: 'premium',
      entitlement_snapshot: {
        version: 'future-unverified-version',
        planKey: 'premium',
        region: 'IN',
        limits: {
          maxLocations: 'unlimited',
          maxActiveUsers: 'unlimited',
          maxActiveRegisters: 'unlimited',
          monthlyPosTransactions: 'unlimited',
          monthlySalesOrders: 'unlimited',
          monthlyEcommerceOrders: 'unlimited',
          monthlyPurchaseOrders: 'unlimited',
          monthlyBills: 'unlimited',
          dailyApiCalls: 'unlimited',
          integrations: 0,
        },
      },
    }, 'IN')
    expect(malformed.planKey).toBe('starter')
    expect(malformed.limits.maxLocations).toBe(2)

    const retiredSnapshot = snapshotFromStoredRow({
      plan_key: 'starter',
      entitlement_snapshot: {
        version: ENTITLEMENT_VERSION,
        planKey: 'retired-india-plan',
        region: 'IN',
        limits: {
          maxLocations: 2,
          maxActiveUsers: 2,
          maxActiveRegisters: 2,
          monthlyPosTransactions: 100,
          monthlySalesOrders: 100,
          monthlyEcommerceOrders: 100,
          monthlyPurchaseOrders: 50,
          monthlyBills: 50,
          dailyApiCalls: 2_000,
          integrations: 0,
        },
      },
    }, 'IN')
    expect(retiredSnapshot.planKey).toBe('retired-india-plan')
    expect(retiredSnapshot.limits.maxLocations).toBe(2)
  })

  it('applies Pro add-on quantities to effective limits without changing the base snapshot', () => {
    const base = snapshotForPlan('IN', 'pro')
    const effective = effectiveEntitlementLimits(base.limits, {
      additional_store_count: 2,
      additional_register_count: 3,
      additional_user_count: 4,
    })

    expect(base.limits).toMatchObject({ maxLocations: 6, maxActiveRegisters: 6, maxActiveUsers: 10 })
    expect(effective).toMatchObject({ maxLocations: 8, maxActiveRegisters: 9, maxActiveUsers: 14 })
  })

  it('blocks exactly at a finite boundary and leaves unlimited values open', () => {
    expect(decideEntitlement('maxActiveUsers', 3, 2, 'Active users').allowed).toBe(true)
    expect(decideEntitlement('maxActiveUsers', 3, 3, 'Active users')).toMatchObject({
      allowed: false,
      code: 'entitlement_limit_reached',
      usage: 3,
      limit: 3,
    })
    expect(decideEntitlement('monthlyPosTransactions', 'unlimited', 100).allowed).toBe(true)
  })

  it('blocks a zero-valued finite entitlement before creating a counter', async () => {
    const fixture = fakeTransaction(0, 0)
    const reservation = await reservePosTransaction(fixture.tx, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
      sourceKey: 'zero-limit-sale',
      now: new Date('2026-08-11T10:00:00.000Z'),
    })

    expect(reservation).toMatchObject({ allowed: false, limit: 0, usage: 0 })
    expect(fixture.getUsed()).toBe(0)
    expect(fixture.deletedEvents).toContain('zero-limit-sale')
  })

  it('treats an expired trial as blocked', () => {
    const access = trialAccessForRow(
      { status: 'active', ends_at: new Date('2026-08-01T00:00:00.000Z') },
      new Date('2026-08-02T00:00:00.000Z'),
    )
    expect(access).toEqual({ entitlement: 'blocked', accessAllowed: false, graceUntil: null })
  })

  it('counts one committed POS sale, makes retries idempotent, and blocks the 51st without a write', async () => {
    const fixture = fakeTransaction(49)
    const first = await reservePosTransaction(fixture.tx, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
      sourceKey: 'sale-1',
      now: new Date('2026-08-11T10:00:00.000Z'),
    })
    const retry = await reservePosTransaction(fixture.tx, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
      sourceKey: 'sale-1',
      now: new Date('2026-08-11T10:00:00.000Z'),
    })
    const fiftyFirst = await reservePosTransaction(fixture.tx, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      storeId: '22222222-2222-4222-8222-222222222222',
      sourceKey: 'sale-2',
      now: new Date('2026-08-11T10:00:00.000Z'),
    })

    expect(first).toMatchObject({ allowed: true, counted: true, replayed: false })
    expect(retry).toMatchObject({ allowed: true, counted: false, replayed: true })
    expect(fiftyFirst).toMatchObject({ allowed: false, code: 'entitlement_limit_reached', limit: 50, usage: 50 })
    expect(fixture.getUsed()).toBe(50)
    expect(fixture.deletedEvents).toContain('sale-2')
  })

  it('serializes two distinct concurrent reservations at the finite counter', async () => {
    const fixture = fakeTransaction(49)
    const results = await Promise.all([
      reservePosTransaction(fixture.tx, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        storeId: '22222222-2222-4222-8222-222222222222',
        sourceKey: 'sale-a',
        now: new Date('2026-08-11T10:00:00.000Z'),
      }),
      reservePosTransaction(fixture.tx, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        storeId: '22222222-2222-4222-8222-222222222222',
        sourceKey: 'sale-b',
        now: new Date('2026-08-11T10:00:00.000Z'),
      }),
    ])

    expect(results.filter((result) => result.allowed)).toHaveLength(1)
    expect(results.filter((result) => !result.allowed)).toHaveLength(1)
    expect(fixture.getUsed()).toBe(50)
  })
})
