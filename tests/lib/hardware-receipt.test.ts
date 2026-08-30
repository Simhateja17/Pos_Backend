import { describe, expect, it } from 'vitest'
import { formatCompanionReceipt } from '../../src/lib/hardwareReceipt'

describe('formatCompanionReceipt', () => {
  it('prints the server-authoritative itemized India sale', () => {
    const receipt = formatCompanionReceipt({
      id: '12345678-0000-0000-0000-000000000000',
      invoiceNumber: 'INV-42',
      subtotal: '250.00',
      discountAmount: '10.00',
      taxAmount: '43.20',
      totalAmount: '283.20',
      cashReceived: '300.00',
      changeDue: '16.80',
      lines: [{ productName: 'Cotton Shirt', sku: 'SHIRT-M', quantity: 2, unitPrice: '125.00', lineTotal: '250.00' }],
      payments: [{ method: 'cash', amount: '283.20' }],
    }, 'Ambel Test Store', 'IN')

    expect(receipt).toContain('Bill INV-42')
    expect(receipt).toContain('Cotton Shirt (SHIRT-M)')
    expect(receipt).toContain('INR 283.20')
    expect(receipt).toContain('Change')
    expect(receipt).not.toContain('USD')
  })

  it('uses International currency and omits absent cash lines', () => {
    const receipt = formatCompanionReceipt({
      id: 'abcdef12-0000-0000-0000-000000000000', subtotal: '10.00', discountAmount: '0.00', taxAmount: '0.80', totalAmount: '10.80',
      lines: [{ productName: 'Item', quantity: 1, unitPrice: '10.00', lineTotal: '10.00' }], payments: [{ method: 'card', amount: '10.80' }],
    }, 'US Store', 'US')
    expect(receipt).toContain('USD 10.80')
    expect(receipt).not.toContain('Cash received')
    expect(receipt).not.toContain('Discount')
  })
})
