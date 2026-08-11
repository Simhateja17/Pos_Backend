import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  buildCreditNoteSnapshot,
  buildTaxInvoiceSnapshot,
  financialYearFor,
  formatDocumentNumber,
  type TaxSaleSource,
} from '../../src/services/taxDocuments'

const seller = {
  legalName: 'Ambel Retail Private Limited',
  tradeName: 'Ambel Retail',
  gstin: '27ABCDE1234F1Z5',
  pan: 'ABCDE1234F',
  addressLine1: '1 Market Road',
  addressLine2: null,
  city: 'Mumbai',
  state: 'Maharashtra',
  stateCode: '27',
  postalCode: '400001',
  country: 'IN',
  phone: null,
  email: null,
}

function source(overrides: Partial<TaxSaleSource> = {}): TaxSaleSource {
  const line = {
    id: '11111111-1111-4111-8111-111111111111',
    variantId: '22222222-2222-4222-8222-222222222222',
    quantity: new Prisma.Decimal('2'),
    unitPrice: new Prisma.Decimal('100.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    isTaxable: true,
    lineTotal: new Prisma.Decimal('200.00'),
    sku: 'KURTA-01',
    productName: 'Cotton Kurta',
    size: 'M',
    color: 'Blue',
    material: 'Cotton',
    unit: 'piece',
    hsnSac: '6203',
  }
  return {
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    storeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    saleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    customerId: null,
    documentDate: new Date('2026-08-11T10:00:00.000Z'),
    timezone: 'Asia/Kolkata',
    invoicePrefix: 'AMB',
    invoiceStartNumber: BigInt(1),
    seller,
    buyer: null,
    sellerState: 'Maharashtra',
    placeOfSupply: 'Maharashtra',
    combinedTaxRate: new Prisma.Decimal('0.18'),
    subtotal: new Prisma.Decimal('200.00'),
    cartDiscount: new Prisma.Decimal('0.00'),
    taxTotal: new Prisma.Decimal('36.00'),
    grandTotal: new Prisma.Decimal('236.00'),
    lines: [line],
    payments: [{ method: 'upi', direction: 'payment', amount: '236.00', referenceCode: 'UPI-123' }],
    ...overrides,
  }
}

describe('GST document numbering and financial-year rules', () => {
  it('uses the India financial year in the configured timezone', () => {
    expect(financialYearFor(new Date('2026-03-31T18:29:59.000Z'))).toBe('2025-26')
    expect(financialYearFor(new Date('2026-03-31T18:30:00.000Z'))).toBe('2026-27')
  })

  it('keeps the configured serial within Rule 46’s 16-character limit', () => {
    const number = formatDocumentNumber('AMB', 'tax_invoice', '2026-27', BigInt(1))
    expect(number).toBe('AMB/26-27/000001')
    expect(number.length).toBeLessThanOrEqual(16)
  })
})

describe('pure GST invoice builder', () => {
  it('splits intrastate GST into CGST and SGST and reconciles Decimal totals', () => {
    const invoice = buildTaxInvoiceSnapshot({
      source: source(),
      financialYear: '2026-27',
      sequenceNumber: BigInt(1),
      documentNumber: 'AMB/26-27/000001',
    })

    expect(invoice.placeOfSupply.isInterState).toBe(false)
    expect(invoice.igstTotal.toString()).toBe('0')
    expect(invoice.cgstTotal.plus(invoice.sgstTotal).toString()).toBe('36')
    expect(invoice.lines[0].cgstAmount).toBe('18')
    expect(invoice.lines[0].sgstAmount).toBe('18')
    expect(invoice.lines[0].lineTotal).toBe('236')
    expect(invoice.grandTotal.toString()).toBe('236')
  })

  it('uses IGST for an interstate place of supply', () => {
    const invoice = buildTaxInvoiceSnapshot({
      source: source({ placeOfSupply: 'Karnataka' }),
      financialYear: '2026-27',
      sequenceNumber: BigInt(2),
      documentNumber: 'AMB/26-27/000002',
    })

    expect(invoice.placeOfSupply.isInterState).toBe(true)
    expect(invoice.cgstTotal.toString()).toBe('0')
    expect(invoice.sgstTotal.toString()).toBe('0')
    expect(invoice.igstTotal.toString()).toBe('36')
    expect(invoice.lines[0].igstAmount).toBe('36')
  })

  it('returns an independent snapshot rather than a live reference to sale settings', () => {
    const sale = source()
    const invoice = buildTaxInvoiceSnapshot({
      source: sale,
      financialYear: '2026-27',
      sequenceNumber: BigInt(3),
      documentNumber: 'AMB/26-27/000003',
    })

    sale.seller.tradeName = 'Changed after issue'
    sale.payments[0].referenceCode = 'changed'
    expect(invoice.seller.tradeName).toBe('Ambel Retail')
    expect(invoice.payments[0].referenceCode).toBe('UPI-123')
  })
})

describe('partial credit-note builder', () => {
  it('reverses only the returned quantity and preserves the original invoice', () => {
    const invoice = buildTaxInvoiceSnapshot({
      source: source(),
      financialYear: '2026-27',
      sequenceNumber: BigInt(4),
      documentNumber: 'AMB/26-27/000004',
    })
    const creditNote = buildCreditNoteSnapshot({
      invoice: { ...invoice, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      returnedLines: [{ saleLineItemId: invoice.lines[0].saleLineItemId!, quantity: '1' }],
      financialYear: '2026-27',
      sequenceNumber: BigInt(1),
      documentNumber: 'CN/26-27/000001',
      documentDate: new Date('2026-08-12T10:00:00.000Z'),
      returnReferenceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      refundPayments: [{ method: 'upi', direction: 'refund', amount: '118.00', referenceCode: 'UPI-REFUND' }],
    })

    expect(creditNote.documentType).toBe('credit_note')
    expect(creditNote.lines).toHaveLength(1)
    expect(creditNote.lines[0].quantity).toBe('1')
    expect(creditNote.lines[0].taxableValue).toBe('100')
    expect(creditNote.lines[0].igstAmount).toBe('0')
    expect(creditNote.grandTotal.toString()).toBe('118')
    expect(invoice.lines[0].quantity).toBe('2')
    expect(invoice.grandTotal.toString()).toBe('236')
  })

  it('rejects a credit-note quantity larger than the original line', () => {
    const invoice = buildTaxInvoiceSnapshot({
      source: source(),
      financialYear: '2026-27',
      sequenceNumber: BigInt(5),
      documentNumber: 'AMB/26-27/000005',
    })

    expect(() => buildCreditNoteSnapshot({
      invoice: { ...invoice, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      returnedLines: [{ saleLineItemId: invoice.lines[0].saleLineItemId!, quantity: '3' }],
      financialYear: '2026-27',
      sequenceNumber: BigInt(2),
      documentNumber: 'CN/26-27/000002',
      documentDate: new Date('2026-08-12T10:00:00.000Z'),
      returnReferenceId: '99999999-9999-4999-8999-999999999999',
      refundPayments: [],
    })).toThrow(/exceeds the original invoice quantity/)
  })
})
