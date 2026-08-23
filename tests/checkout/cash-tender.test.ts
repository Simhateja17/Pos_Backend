import { describe, expect, it } from 'vitest'
import { calculateCashChange } from '../../src/lib/cashTender'

describe('cash tender and change', () => {
  it('assumes exact cash when the physical amount is omitted', () => {
    const result = calculateCashChange([{ method: 'cash', amount: '800.00' }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cashReceived.toFixed(2)).toBe('800.00')
    expect(result.changeDue.toFixed(2)).toBe('0.00')
  })

  it('rejects cash received when there is no cash payment', () => {
    expect(calculateCashChange([{ method: 'upi', amount: '800.00' }], '800.00')).toEqual({
      ok: false,
      error: 'Cash received is only valid when the sale includes a cash payment.',
    })
  })

  it('calculates change without changing the bill allocation', () => {
    const result = calculateCashChange([{ method: 'cash', amount: '800.00' }], '1000.00')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cashPayment.toFixed(2)).toBe('800.00')
    expect(result.cashReceived.toFixed(2)).toBe('1000.00')
    expect(result.changeDue.toFixed(2)).toBe('200.00')
  })

  it('calculates change against only the cash part of a split payment', () => {
    const result = calculateCashChange([
      { method: 'upi', amount: '600.00' },
      { method: 'cash', amount: '400.00' },
    ], '500.00')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changeDue.toFixed(2)).toBe('100.00')
  })

  it('rejects cash received below the allocated cash amount', () => {
    expect(calculateCashChange([{ method: 'cash', amount: '400.00' }], '399.00')).toEqual({
      ok: false,
      error: 'Cash received must be at least 400.00.',
    })
  })
})
