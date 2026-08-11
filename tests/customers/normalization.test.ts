import { describe, expect, it } from 'vitest'
import {
  CustomerValidationError,
  normalizeCustomerInput,
  normalizeEmail,
  normalizeGstin,
  normalizePhone,
} from '../../src/lib/customers'

describe('customer identity normalization', () => {
  it('canonicalizes common Indian phone variants to one identity', () => {
    const variants = ['98765 43210', '09876543210', '919876543210', '+91 98765-43210']
    expect(variants.map(normalizePhone)).toEqual([
      '+919876543210',
      '+919876543210',
      '+919876543210',
      '+919876543210',
    ])
  })

  it('normalizes email case and surrounding whitespace', () => {
    expect(normalizeEmail('  Buyer@Example.COM ')).toBe('buyer@example.com')
  })

  it('uppercases and validates an optional GSTIN without requiring it', () => {
    expect(normalizeGstin('27abcde1234f1z5')).toBe('27ABCDE1234F1Z5')
    expect(normalizeCustomerInput({ phone: '9876543210', stateCode: '27', postalCode: '400001' })).toMatchObject({
      gstin: null,
      stateCode: '27',
      postalCode: '400001',
    })
  })

  it('validates state and PIN independently of GSTIN', () => {
    expect(() => normalizeCustomerInput({ phone: '9876543210', stateCode: 'MH' })).toThrow(CustomerValidationError)
    expect(() => normalizeCustomerInput({ phone: '9876543210', postalCode: '40001' })).toThrow(CustomerValidationError)
    expect(() => normalizeCustomerInput({ phone: '9876543210', gstin: 'not-a-gstin' })).toThrow(CustomerValidationError)
  })

  it('requires phone or email for a saved profile', () => {
    expect(() => normalizeCustomerInput({ billingName: 'Walk-in' })).toThrow('At least one of phone or email is required')
  })
})
