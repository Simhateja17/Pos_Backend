import { Prisma } from '@prisma/client'

export type TaxDocumentType = 'tax_invoice' | 'credit_note'

const ZERO = new Prisma.Decimal(0)
const TWO = new Prisma.Decimal(2)

export interface TaxPartySnapshot {
  legalName: string | null
  tradeName: string | null
  gstin: string | null
  pan: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  stateCode: string | null
  postalCode: string | null
  country: string | null
  phone: string | null
  email: string | null
}

export interface PlaceOfSupplySnapshot {
  state: string | null
  stateCode: string | null
  isInterState: boolean
}

export interface TaxPaymentSnapshot {
  method: string
  direction: string
  amount: string
  referenceCode: string | null
}

export interface TaxDocumentLineSnapshot {
  /** Internal persisted line id used to link a credit note to its invoice line. */
  id?: string
  saleLineItemId: string | null
  originalLineId: string | null
  variantId: string | null
  description: string
  sku: string | null
  hsnSac: string | null
  unit: string
  quantity: string
  unitPrice: string
  grossValue: string
  discountValue: string
  taxableValue: string
  gstRate: string
  cgstAmount: string
  sgstAmount: string
  igstAmount: string
  cessAmount: string
  lineTotal: string
}

export interface TaxDocumentSnapshot {
  id?: string
  documentType: TaxDocumentType
  financialYear: string
  sequenceNumber: string
  documentNumber: string
  documentDate: Date
  tenantId: string
  storeId: string
  saleId: string
  customerId: string | null
  returnReferenceId: string | null
  originalDocumentId: string | null
  originalDocumentNumber: string | null
  seller: TaxPartySnapshot
  buyer: TaxPartySnapshot | null
  placeOfSupply: PlaceOfSupplySnapshot
  payments: TaxPaymentSnapshot[]
  subtotal: Prisma.Decimal
  discountTotal: Prisma.Decimal
  taxableTotal: Prisma.Decimal
  cgstTotal: Prisma.Decimal
  sgstTotal: Prisma.Decimal
  igstTotal: Prisma.Decimal
  cessTotal: Prisma.Decimal
  roundingAmount: Prisma.Decimal
  grandTotal: Prisma.Decimal
  lines: TaxDocumentLineSnapshot[]
}

export type TaxSourceLine = {
  id: string
  variantId: string
  quantity: Prisma.Decimal
  unitPrice: Prisma.Decimal
  discountAmount: Prisma.Decimal
  isTaxable: boolean
  taxRate: Prisma.Decimal
  lineTotal: Prisma.Decimal
  sku: string | null
  productName: string | null
  size: string | null
  color: string | null
  material: string | null
  unit: string
  hsnSac: string | null
}

export type TaxSaleSource = {
  tenantId: string
  storeId: string
  saleId: string
  customerId: string | null
  documentDate: Date
  timezone: string
  invoicePrefix: string
  invoiceStartNumber: bigint
  seller: TaxPartySnapshot
  buyer: TaxPartySnapshot | null
  sellerState: string | null
  placeOfSupply: string | null
  combinedTaxRate: Prisma.Decimal
  subtotal: Prisma.Decimal
  cartDiscount: Prisma.Decimal
  taxTotal: Prisma.Decimal
  grandTotal: Prisma.Decimal
  lines: TaxSourceLine[]
  payments: TaxPaymentSnapshot[]
}

export interface ReturnedTaxLine {
  saleLineItemId: string
  quantity: Prisma.Decimal | string | number
}

const INDIAN_STATE_CODES: Record<string, string> = {
  'JAMMU AND KASHMIR': '01',
  'HIMACHAL PRADESH': '02',
  PUNJAB: '03',
  CHANDIGARH: '04',
  UTTARAKHAND: '05',
  HARYANA: '06',
  DELHI: '07',
  RAJASTHAN: '08',
  'UTTAR PRADESH': '09',
  BIHAR: '10',
  SIKKIM: '11',
  'ARUNACHAL PRADESH': '12',
  NAGALAND: '13',
  MANIPUR: '14',
  MIZORAM: '15',
  TRIPURA: '16',
  MEGHALAYA: '17',
  ASSAM: '18',
  'WEST BENGAL': '19',
  JHARKHAND: '20',
  ODISHA: '21',
  CHHATTISGARH: '22',
  'MADHYA PRADESH': '23',
  GUJARAT: '24',
  'DADRA AND NAGAR HAVELI AND DAMAN AND DIU': '26',
  MAHARASHTRA: '27',
  'ANDHRA PRADESH': '37',
  KARNATAKA: '29',
  GOA: '30',
  LAKSHADWEEP: '31',
  KERALA: '32',
  'TAMIL NADU': '33',
  PUDUCHERRY: '34',
  'ANDAMAN AND NICOBAR ISLANDS': '35',
  TELANGANA: '36',
  LADAKH: '38',
  'OTHER TERRITORY': '97',
}

const UNIT_CODES: Record<string, string> = {
  piece: 'PCS',
  kg: 'KGS',
  gram: 'GMS',
  litre: 'LTR',
  ml: 'MLT',
  metre: 'MTR',
  box: 'BOX',
  pack: 'PAC',
  set: 'SET',
  pair: 'PRS',
}

function decimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value))
}

function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function canonicalState(value: string | null | undefined): string | null {
  const trimmed = nullableString(value)
  if (!trimmed) return null
  return trimmed.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ')
}

export function stateCodeFor(value: string | null | undefined): string | null {
  const canonical = canonicalState(value)
  if (!canonical) return null
  if (/^\d{2}$/.test(canonical)) return canonical
  return INDIAN_STATE_CODES[canonical] ?? null
}

function stateNameFor(value: string | null | undefined): string | null {
  const canonical = canonicalState(value)
  if (!canonical) return null
  if (!/^\d{2}$/.test(canonical)) return canonical
  return Object.entries(INDIAN_STATE_CODES).find(([, code]) => code === canonical)?.[0] ?? canonical
}

export function statesMatch(left: string | null, right: string | null): boolean {
  const leftCode = stateCodeFor(left)
  const rightCode = stateCodeFor(right)
  if (leftCode && rightCode) return leftCode === rightCode
  return canonicalState(left) === canonicalState(right)
}

function readMetadataString(metadata: unknown, keys: string[]): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const record = metadata as Record<string, unknown>
  for (const key of keys) {
    const value = nullableString(record[key])
    if (value) return value
  }
  return null
}

function partySnapshot(input: Record<string, unknown>): TaxPartySnapshot {
  const state = nullableString(input.state) ?? stateNameFor(nullableString(input.stateCode))
  return {
    legalName: nullableString(input.legalName ?? input.name),
    tradeName: nullableString(input.tradeName),
    gstin: nullableString(input.gstin),
    pan: nullableString(input.pan),
    addressLine1: nullableString(input.addressLine1),
    addressLine2: nullableString(input.addressLine2),
    city: nullableString(input.city),
    state,
    stateCode: nullableString(input.stateCode) ?? stateCodeFor(state),
    postalCode: nullableString(input.postalCode),
    country: nullableString(input.country),
    phone: nullableString(input.phone),
    email: nullableString(input.email),
  }
}

function proportionalAllocation(total: Prisma.Decimal, weights: Prisma.Decimal[]): Prisma.Decimal[] {
  const denominator = weights.reduce((sum, weight) => sum.plus(weight), ZERO)
  if (weights.length === 0 || denominator.isZero()) return weights.map(() => ZERO)

  const allocations: Prisma.Decimal[] = []
  let remaining = roundMoney(total)
  for (let index = 0; index < weights.length; index += 1) {
    if (index === weights.length - 1) {
      allocations.push(remaining)
      continue
    }
    const allocation = roundMoney(total.times(weights[index]).dividedBy(denominator))
    allocations.push(allocation)
    remaining = roundMoney(remaining.minus(allocation))
  }
  return allocations
}

function sourceLineDescription(line: TaxSourceLine): string {
  return [line.productName, line.size, line.color, line.material].filter(Boolean).join(' / ') || line.sku || line.variantId
}

function documentLineFromAmounts(
  line: TaxSourceLine,
  values: {
    quantity: Prisma.Decimal
    grossValue: Prisma.Decimal
    discountValue: Prisma.Decimal
    taxableValue: Prisma.Decimal
    tax: Prisma.Decimal
    cgst: Prisma.Decimal
    sgst: Prisma.Decimal
    igst: Prisma.Decimal
    cess: Prisma.Decimal
    lineTotal: Prisma.Decimal
  },
  originalLineId: string | null = null,
): TaxDocumentLineSnapshot {
  const gstRate = line.isTaxable ? ZERO : ZERO
  return {
    saleLineItemId: line.id,
    originalLineId,
    variantId: line.variantId,
    description: sourceLineDescription(line),
    sku: line.sku,
    hsnSac: line.hsnSac,
    unit: UNIT_CODES[line.unit] ?? line.unit.toUpperCase(),
    quantity: values.quantity.toString(),
    unitPrice: roundMoney(line.unitPrice).toString(),
    grossValue: roundMoney(values.grossValue).toString(),
    discountValue: roundMoney(values.discountValue).toString(),
    taxableValue: roundMoney(values.taxableValue).toString(),
    gstRate: gstRate.toString(),
    cgstAmount: roundMoney(values.cgst).toString(),
    sgstAmount: roundMoney(values.sgst).toString(),
    igstAmount: roundMoney(values.igst).toString(),
    cessAmount: roundMoney(values.cess).toString(),
    lineTotal: roundMoney(values.lineTotal).toString(),
  }
}

/**
 * Pure builder for a completed-sale tax invoice. It consumes persisted sale
 * facts and returns a snapshot; it never reads mutable catalogue/settings
 * state after the caller has supplied the source.
 */
export function buildTaxInvoiceSnapshot(input: {
  source: TaxSaleSource
  financialYear: string
  sequenceNumber: bigint
  documentNumber: string
  documentDate?: Date
}): TaxDocumentSnapshot {
  const { source } = input
  const lineBases = source.lines.map((line) =>
    line.unitPrice.times(line.quantity).minus(line.discountAmount),
  )
  const lineSubtotal = lineBases.reduce((sum, value) => sum.plus(value), ZERO)
  const cartDiscountAllocations = proportionalAllocation(source.cartDiscount, lineBases)
  const netLineValues = lineBases.map((value, index) => value.minus(cartDiscountAllocations[index]))
  const taxableWeights = source.lines.map((line, index) => (line.isTaxable ? netLineValues[index] : ZERO))
  const taxableTotal = taxableWeights.reduce((sum, value) => sum.plus(value), ZERO)
  const taxWeights = source.lines.map((line, index) =>
    line.isTaxable ? netLineValues[index].times(line.taxRate) : ZERO,
  )
  const lineTaxes = proportionalAllocation(
    source.taxTotal,
    taxWeights.some((weight) => !weight.isZero()) ? taxWeights : taxableWeights,
  )
  const isInterState = !statesMatch(source.sellerState, source.placeOfSupply)
  const lineSnapshots: TaxDocumentLineSnapshot[] = []

  for (let index = 0; index < source.lines.length; index += 1) {
    const sourceLine = source.lines[index]
    const lineTax = sourceLine.isTaxable ? lineTaxes[index] : ZERO
    const cgst = isInterState ? ZERO : roundMoney(lineTax.dividedBy(TWO))
    const sgst = isInterState ? ZERO : roundMoney(lineTax.minus(cgst))
    const igst = isInterState ? lineTax : ZERO
    const lineTotal = roundMoney(netLineValues[index].plus(lineTax))
    const line = documentLineFromAmounts(sourceLine, {
      quantity: sourceLine.quantity,
      grossValue: sourceLine.unitPrice.times(sourceLine.quantity),
      discountValue: sourceLine.discountAmount.plus(cartDiscountAllocations[index]),
      taxableValue: netLineValues[index],
      tax: lineTax,
      cgst,
      sgst,
      igst,
      cess: ZERO,
      lineTotal,
    })
    line.gstRate = sourceLine.isTaxable ? sourceLine.taxRate.times(100).toString() : ZERO.toString()
    lineSnapshots.push(line)
  }

  const subtotal = roundMoney(lineSubtotal)
  const discountTotal = roundMoney(source.lines.reduce(
    (sum, line, index) => sum.plus(line.discountAmount).plus(cartDiscountAllocations[index]),
    ZERO,
  ))
  const expectedGrandTotal = roundMoney(subtotal.minus(discountTotal).plus(source.taxTotal))
  const roundingAmount = roundMoney(source.grandTotal.minus(expectedGrandTotal))
  if (lineSnapshots.length > 0 && !roundingAmount.isZero()) {
    const last = lineSnapshots[lineSnapshots.length - 1]
    last.lineTotal = roundMoney(decimal(last.lineTotal).plus(roundingAmount)).toString()
  }

  return {
    documentType: 'tax_invoice',
    financialYear: input.financialYear,
    sequenceNumber: input.sequenceNumber.toString(),
    documentNumber: input.documentNumber,
    documentDate: input.documentDate ?? source.documentDate,
    tenantId: source.tenantId,
    storeId: source.storeId,
    saleId: source.saleId,
    customerId: source.customerId,
    returnReferenceId: null,
    originalDocumentId: null,
    originalDocumentNumber: null,
    seller: { ...source.seller },
    buyer: source.buyer ? { ...source.buyer } : null,
    placeOfSupply: {
      state: source.placeOfSupply,
      stateCode: stateCodeFor(source.placeOfSupply),
      isInterState,
    },
    payments: source.payments.map((payment) => ({ ...payment })),
    subtotal,
    discountTotal,
    taxableTotal: roundMoney(taxableTotal),
    cgstTotal: lineSnapshots.reduce((sum, line) => sum.plus(decimal(line.cgstAmount)), ZERO),
    sgstTotal: lineSnapshots.reduce((sum, line) => sum.plus(decimal(line.sgstAmount)), ZERO),
    igstTotal: lineSnapshots.reduce((sum, line) => sum.plus(decimal(line.igstAmount)), ZERO),
    cessTotal: ZERO,
    roundingAmount,
    grandTotal: roundMoney(source.grandTotal),
    lines: lineSnapshots,
  }
}

/** Builds a positive-value credit note for only the returned quantities. */
export function buildCreditNoteSnapshot(input: {
  invoice: TaxDocumentSnapshot
  returnedLines: ReturnedTaxLine[]
  financialYear: string
  sequenceNumber: bigint
  documentNumber: string
  documentDate: Date
  returnReferenceId: string
  refundPayments: TaxPaymentSnapshot[]
}): TaxDocumentSnapshot {
  const returnedByLine = new Map<string, Prisma.Decimal>()
  for (const returnedLine of input.returnedLines) {
    const quantity = decimal(returnedLine.quantity)
    if (quantity.isNegative() || quantity.isZero()) throw new Error('Credit-note quantity must be positive')
    returnedByLine.set(
      returnedLine.saleLineItemId,
      (returnedByLine.get(returnedLine.saleLineItemId) ?? ZERO).plus(quantity),
    )
  }
  const lines: TaxDocumentLineSnapshot[] = []
  const matchedLineIds = new Set<string>()

  for (const original of input.invoice.lines) {
    if (!original.saleLineItemId) continue
    const returnedQuantity = returnedByLine.get(original.saleLineItemId)
    if (!returnedQuantity || returnedQuantity.isZero()) continue
    const originalQuantity = decimal(original.quantity)
    if (originalQuantity.isZero() || returnedQuantity.greaterThan(originalQuantity)) {
      throw new Error(`Credit-note quantity exceeds the original invoice quantity for ${original.saleLineItemId}`)
    }
    matchedLineIds.add(original.saleLineItemId)
    const ratio = returnedQuantity.dividedBy(originalQuantity)
    const scale = (value: string) => roundMoney(decimal(value).times(ratio))
    const grossValue = scale(original.grossValue)
    const discountValue = scale(original.discountValue)
    const taxableValue = scale(original.taxableValue)
    const cgst = scale(original.cgstAmount)
    const sgst = scale(original.sgstAmount)
    const igst = scale(original.igstAmount)
    const cess = scale(original.cessAmount)
    // Preserve any invoice-level rounding carried by this line. The return
    // route refunds from the immutable invoice line total, so recalculating
    // only from the prorated components could make the credit note differ by
    // a paisa and fail exact refund reconciliation.
    const lineTotal = roundMoney(decimal(original.lineTotal).times(ratio))

    lines.push({
      ...original,
      id: undefined,
      originalLineId: original.id ?? null,
      quantity: returnedQuantity.toString(),
      grossValue: grossValue.toString(),
      discountValue: discountValue.toString(),
      taxableValue: taxableValue.toString(),
      cgstAmount: cgst.toString(),
      sgstAmount: sgst.toString(),
      igstAmount: igst.toString(),
      cessAmount: cess.toString(),
      lineTotal: lineTotal.toString(),
    })
  }

  for (const saleLineItemId of returnedByLine.keys()) {
    if (!matchedLineIds.has(saleLineItemId)) {
      throw new Error(`Credit-note line ${saleLineItemId} is not present on the original invoice`)
    }
  }

  const sum = (field: keyof TaxDocumentLineSnapshot) =>
    lines.reduce((total, line) => total.plus(decimal(line[field] as string)), ZERO)
  const grandTotal = roundMoney(sum('lineTotal'))
  const paymentTotal = input.refundPayments.reduce((total, payment) => total.plus(decimal(payment.amount)), ZERO)
  if (!paymentTotal.equals(grandTotal)) {
    throw new Error(`Credit-note payments must equal the returned document total (${grandTotal.toString()})`)
  }
  const roundingAmount = roundMoney(
    grandTotal.minus(
      sum('grossValue')
        .minus(sum('discountValue'))
        .plus(sum('cgstAmount'))
        .plus(sum('sgstAmount'))
        .plus(sum('igstAmount'))
        .plus(sum('cessAmount')),
    ),
  )

  return {
    documentType: 'credit_note',
    financialYear: input.financialYear,
    sequenceNumber: input.sequenceNumber.toString(),
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    tenantId: input.invoice.tenantId,
    storeId: input.invoice.storeId,
    saleId: input.invoice.saleId,
    customerId: input.invoice.customerId,
    returnReferenceId: input.returnReferenceId,
    originalDocumentId: input.invoice.id ?? null,
    originalDocumentNumber: input.invoice.documentNumber,
    seller: { ...input.invoice.seller },
    buyer: input.invoice.buyer ? { ...input.invoice.buyer } : null,
    placeOfSupply: { ...input.invoice.placeOfSupply },
    payments: input.refundPayments.map((payment) => ({ ...payment })),
    subtotal: roundMoney(sum('grossValue')),
    discountTotal: roundMoney(sum('discountValue')),
    taxableTotal: roundMoney(sum('taxableValue')),
    cgstTotal: roundMoney(sum('cgstAmount')),
    sgstTotal: roundMoney(sum('sgstAmount')),
    igstTotal: roundMoney(sum('igstAmount')),
    cessTotal: roundMoney(sum('cessAmount')),
    roundingAmount,
    grandTotal,
    lines,
  }
}

export function financialYearFor(date: Date, timezone = 'Asia/Kolkata'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const start = month < 4 ? year - 1 : year
  return `${start}-${String(start + 1).slice(-2)}`
}

function documentPrefix(prefix: string, type: TaxDocumentType): string {
  if (type === 'credit_note') return 'CN'
  // Rule 46 caps the complete invoice serial at 16 characters. With the
  // compact FY and six-digit serial below, only three prefix characters fit.
  const clean = prefix.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3)
  return clean || 'INV'
}

export function formatDocumentNumber(prefix: string, type: TaxDocumentType, financialYear: string, sequenceNumber: bigint): string {
  const shortYear = financialYear.slice(2)
  const number = `${documentPrefix(prefix, type)}/${shortYear}/${sequenceNumber.toString().padStart(6, '0')}`
  if (number.length > 16) throw new Error('GST document number exceeds the 16-character limit')
  return number
}

async function loadSaleSource(tx: any, tenantId: string, saleId: string): Promise<TaxSaleSource> {
  const sale = await tx.sales.findFirst({ where: { id: saleId, tenant_id: tenantId } })
  if (!sale) throw new Error('Sale not found')

  const [tenant, store, customer, lines, payments] = await Promise.all([
    tx.tenants.findFirst({ where: { id: tenantId } }),
    tx.stores.findFirst({ where: { id: sale.store_id, is_active: true } }),
    sale.customer_id ? tx.customers.findFirst({ where: { id: sale.customer_id } }) : null,
    tx.sale_line_items.findMany({
      where: { sale_id: sale.id, tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
      include: { variants: { include: { products: true } } },
    }),
    tx.payments.findMany({ where: { sale_id: sale.id, tenant_id: tenantId, direction: 'payment' }, orderBy: { created_at: 'asc' } }),
  ])
  if (!tenant || !store) throw new Error('Seller store not found')

  const tenantRecord = tenant as Record<string, unknown>
  const storeRecord = store as Record<string, unknown>
  const customerRecord = customer as Record<string, unknown> | null
  const seller = partySnapshot({
    legalName: tenantRecord.business_name,
    tradeName: tenantRecord.trade_name,
    gstin: tenantRecord.tax_id,
    pan: tenantRecord.pan,
    addressLine1: storeRecord.address_line1,
    addressLine2: storeRecord.address_line2,
    city: storeRecord.city,
    state: storeRecord.state ?? tenantRecord.state,
    postalCode: storeRecord.postal_code,
    country: storeRecord.country ?? tenantRecord.country,
  })
  const buyer = customerRecord
    ? partySnapshot({
        name: customerRecord.billing_name ?? customerRecord.name,
        gstin: customerRecord.gstin ?? customerRecord.tax_id,
        addressLine1: customerRecord.address_line1,
        addressLine2: customerRecord.address_line2,
        city: customerRecord.city,
        stateCode: customerRecord.state_code,
        postalCode: customerRecord.postal_code,
        country: customerRecord.country,
        phone: customerRecord.phone,
        email: customerRecord.email,
      })
    : null

  const combinedTaxRate = decimal(storeRecord.tax_rate_state)
    .plus(decimal(storeRecord.tax_rate_county))
    .plus(decimal(storeRecord.tax_rate_city))
    .plus(decimal(storeRecord.tax_rate_district))

  return {
    tenantId,
    storeId: sale.store_id,
    saleId: sale.id,
    customerId: sale.customer_id ?? null,
    documentDate: sale.created_at,
    timezone: String(tenantRecord.timezone ?? 'Asia/Kolkata'),
    invoicePrefix: String(storeRecord.invoice_prefix ?? 'INV'),
    invoiceStartNumber: BigInt(String(storeRecord.invoice_start_number ?? 1)),
    seller,
    buyer,
    sellerState: seller.state,
    placeOfSupply: nullableString(storeRecord.place_of_supply) ?? seller.state,
    combinedTaxRate,
    subtotal: decimal(sale.subtotal),
    cartDiscount: decimal(sale.discount_amount),
    taxTotal: decimal(sale.tax_amount),
    grandTotal: decimal(sale.total_amount),
    lines: (lines as any[]).map((line) => {
      const variant = line.variants as Record<string, unknown>
      const product = variant.products as Record<string, unknown> | null
      return {
        id: line.id,
        variantId: line.variant_id,
        quantity: decimal(line.quantity),
        unitPrice: decimal(line.unit_price),
        discountAmount: decimal(line.discount_amount),
        isTaxable: Boolean(line.is_taxable),
        taxRate: line.tax_rate == null ? combinedTaxRate : decimal(line.tax_rate),
        lineTotal: decimal(line.line_total),
        sku: nullableString(variant.sku),
        productName: nullableString(product?.name),
        size: nullableString(variant.size),
        color: nullableString(variant.color),
        material: nullableString(variant.material),
        unit: String(variant.unit_of_measure ?? 'piece'),
        hsnSac: readMetadataString(variant.source_metadata, ['hsnSac', 'hsnCode', 'hsn', 'sac']),
      }
    }),
    payments: (payments as any[]).map((payment) => ({
      method: String(payment.method),
      direction: String(payment.direction),
      amount: decimal(payment.amount).toString(),
      referenceCode: nullableString(payment.reference_code),
    })),
  }
}

function jsonSnapshot(snapshot: TaxDocumentSnapshot) {
  return {
    seller_snapshot: snapshot.seller,
    buyer_snapshot: snapshot.buyer,
    place_of_supply_snapshot: snapshot.placeOfSupply,
    payment_snapshot: snapshot.payments,
  }
}

async function allocateSequence(tx: any, source: TaxSaleSource, type: TaxDocumentType, financialYear: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ sequence_number: bigint | number | string }>>`
    SELECT public.allocate_tax_document_sequence(
      ${source.tenantId}::uuid,
      ${source.storeId}::uuid,
      ${type}::public.tax_document_type,
      ${financialYear},
      ${type === 'tax_invoice' ? source.invoiceStartNumber : BigInt(1)}::bigint
    ) AS sequence_number
  `
  if (!rows[0]) throw new Error('Could not allocate tax document number')
  return BigInt(String(rows[0].sequence_number))
}

async function insertSnapshot(tx: any, snapshot: TaxDocumentSnapshot, createdBy: string | null): Promise<void> {
  const created = await tx.tax_documents.create({
    data: {
      tenant_id: snapshot.tenantId,
      store_id: snapshot.storeId,
      document_type: snapshot.documentType,
      financial_year: snapshot.financialYear,
      sequence_number: BigInt(snapshot.sequenceNumber),
      document_number: snapshot.documentNumber,
      document_date: snapshot.documentDate,
      sale_id: snapshot.saleId,
      customer_id: snapshot.customerId,
      return_reference_id: snapshot.returnReferenceId,
      original_document_id: snapshot.originalDocumentId,
      ...jsonSnapshot(snapshot),
      subtotal: snapshot.subtotal.toString(),
      discount_total: snapshot.discountTotal.toString(),
      taxable_total: snapshot.taxableTotal.toString(),
      cgst_total: snapshot.cgstTotal.toString(),
      sgst_total: snapshot.sgstTotal.toString(),
      igst_total: snapshot.igstTotal.toString(),
      cess_total: snapshot.cessTotal.toString(),
      rounding_amount: snapshot.roundingAmount.toString(),
      grand_total: snapshot.grandTotal.toString(),
      created_by: createdBy,
    },
  })

  for (let index = 0; index < snapshot.lines.length; index += 1) {
    const line = snapshot.lines[index]
    await tx.tax_document_lines.create({
      data: {
        tenant_id: snapshot.tenantId,
        document_id: created.id,
        line_number: index + 1,
        sale_line_item_id: line.saleLineItemId,
        original_line_id: line.originalLineId,
        variant_id: line.variantId,
        description: line.description,
        sku: line.sku,
        hsn_sac: line.hsnSac,
        unit: line.unit,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        gross_value: line.grossValue,
        discount_value: line.discountValue,
        taxable_value: line.taxableValue,
        gst_rate: line.gstRate,
        cgst_amount: line.cgstAmount,
        sgst_amount: line.sgstAmount,
        igst_amount: line.igstAmount,
        cess_amount: line.cessAmount,
        line_total: line.lineTotal,
      },
    })
  }
}

export function toTaxDocumentJson(row: any, lines: any[] = []): TaxDocumentSnapshot & { id: string; createdAt: string } {
  return {
    id: row.id,
    documentType: row.document_type,
    financialYear: row.financial_year,
    sequenceNumber: String(row.sequence_number),
    documentNumber: row.document_number,
    documentDate: row.document_date,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    saleId: row.sale_id,
    customerId: row.customer_id,
    returnReferenceId: row.return_reference_id,
    originalDocumentId: row.original_document_id,
    originalDocumentNumber: null,
    seller: row.seller_snapshot,
    buyer: row.buyer_snapshot,
    placeOfSupply: row.place_of_supply_snapshot,
    payments: row.payment_snapshot,
    subtotal: decimal(row.subtotal),
    discountTotal: decimal(row.discount_total),
    taxableTotal: decimal(row.taxable_total),
    cgstTotal: decimal(row.cgst_total),
    sgstTotal: decimal(row.sgst_total),
    igstTotal: decimal(row.igst_total),
    cessTotal: decimal(row.cess_total),
    roundingAmount: decimal(row.rounding_amount),
    grandTotal: decimal(row.grand_total),
    lines: lines.map((line) => {
      const snapshot: TaxDocumentLineSnapshot = {
        saleLineItemId: line.sale_line_item_id,
        originalLineId: line.original_line_id,
        variantId: line.variant_id,
        description: line.description,
        sku: line.sku,
        hsnSac: line.hsn_sac,
        unit: line.unit,
        quantity: decimal(line.quantity).toString(),
        unitPrice: decimal(line.unit_price).toString(),
        grossValue: decimal(line.gross_value).toString(),
        discountValue: decimal(line.discount_value).toString(),
        taxableValue: decimal(line.taxable_value).toString(),
        gstRate: decimal(line.gst_rate).toString(),
        cgstAmount: decimal(line.cgst_amount).toString(),
        sgstAmount: decimal(line.sgst_amount).toString(),
        igstAmount: decimal(line.igst_amount).toString(),
        cessAmount: decimal(line.cess_amount).toString(),
        lineTotal: decimal(line.line_total).toString(),
      }
      // Keep the database line id available to the credit-note builder while
      // keeping it out of the public printable/API shape.
      Object.defineProperty(snapshot, 'id', { value: line.id, enumerable: false })
      return snapshot
    }),
    createdAt: row.created_at.toISOString(),
  }
}

export async function readTaxDocument(tx: any, tenantId: string, documentId: string) {
  const row = await tx.tax_documents.findFirst({ where: { id: documentId, tenant_id: tenantId } })
  if (!row) return null
  const lines = await tx.tax_document_lines.findMany({
    where: { document_id: row.id, tenant_id: tenantId },
    orderBy: { line_number: 'asc' },
  })
  const result = toTaxDocumentJson(row, lines)
  if (row.original_document_id) {
    const original = await tx.tax_documents.findFirst({
      where: { id: row.original_document_id, tenant_id: tenantId },
      select: { document_number: true },
    })
    result.originalDocumentNumber = original?.document_number ?? null
  }
  return result
}

async function lockTaxInvoiceSale(tx: any, tenantId: string, saleId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ sale_id: string | null }>>`
    SELECT public.lock_tax_invoice_sale(
      ${tenantId}::uuid,
      ${saleId}::uuid
    ) AS sale_id
  `
  return rows[0]?.sale_id ?? null
}

/**
 * Creates or returns the one invoice for a sale. The sale row is locked before
 * checking/allocating so concurrent first reads do not burn sequence numbers.
 */
export async function ensureTaxInvoice(tx: any, input: { tenantId: string; saleId: string; createdBy?: string | null }) {
  const lockedSaleId = await lockTaxInvoiceSale(tx, input.tenantId, input.saleId)
  if (!lockedSaleId) return null

  const existing = await tx.tax_documents.findFirst({
    where: { tenant_id: input.tenantId, sale_id: input.saleId, document_type: 'tax_invoice' },
  })
  if (existing) return readTaxDocument(tx, input.tenantId, existing.id)

  const source = await loadSaleSource(tx, input.tenantId, input.saleId)
  const financialYear = financialYearFor(source.documentDate, source.timezone)
  const sequenceNumber = await allocateSequence(tx, source, 'tax_invoice', financialYear)
  const documentNumber = formatDocumentNumber(source.invoicePrefix, 'tax_invoice', financialYear, sequenceNumber)
  const snapshot = buildTaxInvoiceSnapshot({ source, financialYear, sequenceNumber, documentNumber })
  await insertSnapshot(tx, snapshot, input.createdBy ?? null)
  const created = await tx.tax_documents.findFirst({
    where: { tenant_id: input.tenantId, document_number: documentNumber },
  })
  return created ? readTaxDocument(tx, input.tenantId, created.id) : null
}

export async function createCreditNoteForReturn(tx: any, input: {
  tenantId: string
  saleId: string
  returnReferenceId: string
  returnedLines: ReturnedTaxLine[]
  refundPayments: TaxPaymentSnapshot[]
  createdBy?: string | null
}) {
  const existing = await tx.tax_documents.findFirst({
    where: {
      tenant_id: input.tenantId,
      document_type: 'credit_note',
      return_reference_id: input.returnReferenceId,
    },
  })
  if (existing) return { document: await readTaxDocument(tx, input.tenantId, existing.id), idempotent: true }

  const invoice = await ensureTaxInvoice(tx, {
    tenantId: input.tenantId,
    saleId: input.saleId,
    createdBy: input.createdBy,
  })
  if (!invoice) throw new Error('Original tax invoice not found')

  const source = await loadSaleSource(tx, input.tenantId, input.saleId)
  const financialYear = financialYearFor(new Date(), source.timezone)
  const sequenceNumber = await allocateSequence(tx, source, 'credit_note', financialYear)
  const documentNumber = formatDocumentNumber(source.invoicePrefix, 'credit_note', financialYear, sequenceNumber)
  const snapshot = buildCreditNoteSnapshot({
    invoice,
    returnedLines: input.returnedLines,
    financialYear,
    sequenceNumber,
    documentNumber,
    documentDate: new Date(),
    returnReferenceId: input.returnReferenceId,
    refundPayments: input.refundPayments,
  })
  await insertSnapshot(tx, snapshot, input.createdBy ?? null)
  const created = await tx.tax_documents.findFirst({
    where: { tenant_id: input.tenantId, document_number: documentNumber },
  })
  return { document: created ? await readTaxDocument(tx, input.tenantId, created.id) : null, idempotent: false }
}
