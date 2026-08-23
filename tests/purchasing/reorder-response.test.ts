import { describe, expect, it } from 'vitest'
import { toSuggestionJson } from '../../src/routes/reorder'

describe('reorder suggestion response compatibility', () => {
  it('maps legacy persisted reason.stock to currentStock', () => {
    const response = toSuggestionJson({
      id: 'suggestion-1',
      variant_id: 'variant-1',
      variants: { sku: 'QA-ZERO-01', products: { name: 'Zero Stock Basic Tee' } },
      supplier_id: null,
      suppliers: null,
      suggested_quantity: 24,
      method: 'forecast',
      confidence: 'high',
      reason: { stock: 3, onOrder: 0 },
      generated_at: new Date('2026-08-19T00:00:00Z'),
    })

    expect(response.reason.currentStock).toBe(3)
  })
})
