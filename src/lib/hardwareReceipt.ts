export type CompanionReceiptSale = {
  id: string
  invoiceNumber?: string | null
  createdAt?: string
  subtotal: string
  discountAmount: string
  taxAmount: string
  totalAmount: string
  cashReceived?: string | null
  changeDue?: string
  lines: Array<{ productName?: string | null; sku?: string | null; quantity: number; unitPrice: string; lineTotal: string }>
  payments: Array<{ method: string; amount: string }>
}

export function formatCompanionReceipt(sale: CompanionReceiptSale, businessName: string, country: string): string {
  const currency = country === 'IN' ? 'INR' : 'USD'
  const rule = '-'.repeat(42)
  const rows = [
    businessName,
    `Bill ${sale.invoiceNumber ?? `#${sale.id.slice(0, 8)}`}`,
    sale.createdAt ? new Date(sale.createdAt).toLocaleString(country === 'IN' ? 'en-IN' : 'en-US') : '',
    rule,
    ...sale.lines.flatMap((line) => [
      `${line.productName ?? line.sku ?? 'Item'}${line.sku ? ` (${line.sku})` : ''}`,
      `${line.quantity} x ${line.unitPrice}`.padEnd(28) + `${currency} ${line.lineTotal}`,
    ]),
    rule,
    'Subtotal'.padEnd(28) + `${currency} ${sale.subtotal}`,
    Number(sale.discountAmount) > 0 ? 'Discount'.padEnd(28) + `-${currency} ${sale.discountAmount}` : '',
    'Tax'.padEnd(28) + `${currency} ${sale.taxAmount}`,
    'TOTAL'.padEnd(28) + `${currency} ${sale.totalAmount}`,
    rule,
    ...sale.payments.map((payment) => payment.method.toUpperCase().padEnd(28) + `${currency} ${payment.amount}`),
    sale.cashReceived ? 'Cash received'.padEnd(28) + `${currency} ${sale.cashReceived}` : '',
    sale.cashReceived ? 'Change'.padEnd(28) + `${currency} ${sale.changeDue ?? '0.00'}` : '',
    rule,
    'Thank you',
    '',
  ]
  return rows.filter((row) => row !== '').join('\n')
}
