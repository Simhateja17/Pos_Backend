import { describe, it, expect } from 'vitest'
import {
  computeReorder,
  REVIEW_PERIOD_DAYS,
  SAFETY_DAYS,
  VELOCITY_WINDOW_DAYS,
  type ReorderReason,
} from '../../src/services/reorder-heuristic'

/**
 * ML-03's literal requirement: the stored `reason` must reproduce
 * `suggested_quantity`. This recomputes the number from the reason JSON alone,
 * touching none of the service's internals — if the two ever diverge, the
 * "why" shown to the owner is decorative and ML-03 is not met.
 */
function recomputeFromReason(reason: ReorderReason): number {
  const dailyVelocity = reason.netUnitsInWindow / Math.max(1, Math.min(reason.historyDays, reason.windowDays))
  const leadTimeDemand = dailyVelocity * reason.leadTimeDays
  const safetyStock = dailyVelocity * reason.safetyDays
  const reorderPoint = leadTimeDemand + safetyStock
  const reviewDemand = dailyVelocity * reason.reviewPeriodDays
  return Math.ceil(reorderPoint + reviewDemand - reason.currentStock - reason.onOrder)
}

describe('rule-based reorder heuristic', () => {
  it('Test 1: a worked example produces the hand-computed quantity', () => {
    // 60 units net over 30 days = 2/day. Lead time 5 days.
    //   lead_time_demand = 2 * 5  = 10
    //   safety_stock     = 2 * 7  = 14
    //   reorder_point            = 24
    //   review_demand    = 2 * 7  = 14
    //   raw = 24 + 14 - 12 (stock) - 0 (on order) = 26
    const outcome = computeReorder({
      unitsSoldInWindow: 60,
      returnsInWindow: 0,
      historyDays: 30,
      currentStock: 12,
      onOrder: 0,
      leadTimeDays: 5,
      supplierName: 'Fabindia Mills',
    })

    expect(outcome.kind).toBe('suggest')
    if (outcome.kind !== 'suggest') return
    expect(outcome.reason.dailyVelocity).toBe(2)
    expect(outcome.reason.leadTimeDemand).toBe(10)
    expect(outcome.reason.safetyStock).toBe(14)
    expect(outcome.reason.reorderPoint).toBe(24)
    expect(outcome.reason.reviewPeriodDemand).toBe(14)
    expect(outcome.quantity).toBe(26)
  })

  it('Test 2 (ML-03): reason reconstructs suggested_quantity across many shapes', () => {
    const cases = [
      { unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 30, currentStock: 12, onOrder: 0, leadTimeDays: 5 },
      { unitsSoldInWindow: 90, returnsInWindow: 5, historyDays: 30, currentStock: 3, onOrder: 10, leadTimeDays: 14 },
      { unitsSoldInWindow: 45, returnsInWindow: 2, historyDays: 21, currentStock: 0, onOrder: 0, leadTimeDays: 3 },
      { unitsSoldInWindow: 200, returnsInWindow: 12, historyDays: 30, currentStock: 40, onOrder: 25, leadTimeDays: 7 },
      { unitsSoldInWindow: 17, returnsInWindow: 1, historyDays: 16, currentStock: 1, onOrder: 0, leadTimeDays: 10 },
    ]

    for (const input of cases) {
      const outcome = computeReorder({ ...input, supplierName: 'S' })
      if (outcome.kind !== 'suggest') continue
      expect(recomputeFromReason(outcome.reason)).toBe(outcome.quantity)
    }
  })

  it('Test 3: on_order is subtracted — stock already in transit is never re-ordered', () => {
    const base = {
      unitsSoldInWindow: 60,
      returnsInWindow: 0,
      historyDays: 30,
      currentStock: 12,
      leadTimeDays: 5,
      supplierName: 'S',
    }
    const without = computeReorder({ ...base, onOrder: 0 })
    const with20 = computeReorder({ ...base, onOrder: 20 })

    expect(without.kind).toBe('suggest')
    expect(with20.kind).toBe('suggest')
    if (without.kind !== 'suggest' || with20.kind !== 'suggest') return

    // 26 outstanding, 20 already coming -> only 6 still needed.
    expect(without.quantity).toBe(26)
    expect(with20.quantity).toBe(6)
    expect(with20.reason.onOrder).toBe(20)
  })

  it('Test 4: enough on order to cover the need produces no suggestion at all', () => {
    const outcome = computeReorder({
      unitsSoldInWindow: 60,
      returnsInWindow: 0,
      historyDays: 30,
      currentStock: 12,
      onOrder: 500,
      leadTimeDays: 5,
      supplierName: 'S',
    })
    expect(outcome.kind).toBe('sufficient_stock')
  })

  it('Test 5: a zero-velocity variant gets silence, not "order 0"', () => {
    const outcome = computeReorder({
      unitsSoldInWindow: 0,
      returnsInWindow: 0,
      historyDays: 30,
      currentStock: 0,
      onOrder: 0,
      leadTimeDays: 5,
      supplierName: 'S',
    })
    expect(outcome.kind).toBe('no_velocity')
  })

  it('Test 6: under 14 days of history says so instead of extrapolating', () => {
    // 3 days, 9 units. Extrapolating would claim 3/day and a large order.
    const outcome = computeReorder({
      unitsSoldInWindow: 9,
      returnsInWindow: 0,
      historyDays: 3,
      currentStock: 0,
      onOrder: 0,
      leadTimeDays: 7,
      supplierName: 'S',
    })
    expect(outcome.kind).toBe('insufficient_history')
    if (outcome.kind !== 'insufficient_history') return
    expect(outcome.historyDays).toBe(3)
  })

  it('Test 7: returns reduce demand — a sold-then-returned unit was never demand', () => {
    const noReturns = computeReorder({
      unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 30,
      currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S',
    })
    const withReturns = computeReorder({
      unitsSoldInWindow: 60, returnsInWindow: 30, historyDays: 30,
      currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S',
    })
    if (noReturns.kind !== 'suggest' || withReturns.kind !== 'suggest') throw new Error('expected suggestions')

    expect(noReturns.reason.dailyVelocity).toBe(2)
    expect(withReturns.reason.dailyVelocity).toBe(1)
    expect(withReturns.quantity).toBeLessThan(noReturns.quantity)
  })

  it('Test 8: velocity divides by observed history, not the full window', () => {
    // 40 units over 20 days of history is 2/day, not 40/30 = 1.33/day.
    const outcome = computeReorder({
      unitsSoldInWindow: 40, returnsInWindow: 0, historyDays: 20,
      currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S',
    })
    if (outcome.kind !== 'suggest') throw new Error('expected a suggestion')
    expect(outcome.reason.dailyVelocity).toBe(2)
  })

  it('Test 9: confidence bands widen with history and never claim false precision', () => {
    const at20 = computeReorder({ unitsSoldInWindow: 40, returnsInWindow: 0, historyDays: 20, currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S' })
    const at30 = computeReorder({ unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 30, currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S' })
    const at90 = computeReorder({ unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 90, currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S' })

    if (at20.kind !== 'suggest' || at30.kind !== 'suggest' || at90.kind !== 'suggest') throw new Error('expected suggestions')
    expect(at20.confidence).toBe('low')
    expect(at30.confidence).toBe('medium')
    expect(at90.confidence).toBe('high')
  })

  it('Test 10: the reason records every constant, so the number is auditable without reading the code', () => {
    const outcome = computeReorder({
      unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 30,
      currentStock: 12, onOrder: 0, leadTimeDays: 5, supplierName: 'Fabindia Mills',
    })
    if (outcome.kind !== 'suggest') throw new Error('expected a suggestion')

    expect(outcome.reason.formula).toBe('velocity_x_lead_time')
    expect(outcome.reason.windowDays).toBe(VELOCITY_WINDOW_DAYS)
    expect(outcome.reason.safetyDays).toBe(SAFETY_DAYS)
    expect(outcome.reason.reviewPeriodDays).toBe(REVIEW_PERIOD_DAYS)
    expect(outcome.reason.supplierName).toBe('Fabindia Mills')
    expect(outcome.reason.leadTimeDays).toBe(5)
    expect(outcome.reason.currentStock).toBe(12)
  })

  it('Test 11 (Phase 8): a suggestion defaults to this shop\'s own history', () => {
    const outcome = computeReorder({
      unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 90,
      currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S',
    })
    if (outcome.kind !== 'suggest') throw new Error('expected a suggestion')

    expect(outcome.reason.basis).toBe('this_store')
    expect(outcome.confidence).toBe('high')
  })

  it('Test 12 (Phase 8): a borrowed pattern is labelled and can never be high confidence', () => {
    // Same inputs as Test 11 — 90 days of history — but the history belongs to
    // the business's OTHER shops. The uncertainty being reported is "does this
    // new shop behave like the others", which no amount of their data answers.
    const outcome = computeReorder({
      basis: 'other_stores',
      unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 90,
      currentStock: 0, onOrder: 0, leadTimeDays: 5, supplierName: 'S',
    })
    if (outcome.kind !== 'suggest') throw new Error('expected a suggestion')

    expect(outcome.reason.basis).toBe('other_stores')
    expect(outcome.confidence).toBe('low')
  })

  it('Test 13 (Phase 8): borrowing changes only the label and confidence, not the arithmetic', () => {
    const inputs = {
      unitsSoldInWindow: 60, returnsInWindow: 0, historyDays: 90,
      currentStock: 10, onOrder: 5, leadTimeDays: 5, supplierName: 'S',
    } as const
    const own = computeReorder({ ...inputs })
    const borrowed = computeReorder({ ...inputs, basis: 'other_stores' })
    if (own.kind !== 'suggest' || borrowed.kind !== 'suggest') throw new Error('expected suggestions')

    expect(borrowed.quantity).toBe(own.quantity)
    expect(borrowed.reason.rawSuggestion).toBe(own.reason.rawSuggestion)
  })
})
