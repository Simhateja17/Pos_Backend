import { createHash, randomUUID } from 'node:crypto'
import { forTenantTransaction } from '../db/tenantClient'
import {
  type DateOrder,
  detectDateOrder,
  parseCsv,
  parseDateInZone,
  parseNumber,
} from './csv-parse'
import { type ImportKind, targetFieldsFor } from '../contracts/schemas/import'

/**
 * ONBOARD-02 Task 4 — apply a confirmed import.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **The whole import applies or none of it does.** Everything runs inside one
 *    forTenantTransaction. A failure 4,000 rows in leaves no partial history.
 *
 * 2. **Imported sales write real `sales` + `sale_line_items` rows.** That is not
 *    an implementation detail — `daily_sales_rollup` is populated by an AFTER
 *    INSERT trigger on `sale_line_items` (migration 0022), so writing the ledger
 *    properly is what makes the history visible to the Phase 5 reorder
 *    heuristics and the Phase 6 forecast. Any shortcut that bypasses
 *    `sale_line_items` leaves the rollup empty and defeats the entire feature.
 */

export type ConfirmedMapping = { column: string; target: string | null }

export type ImportResult = {
  rowsRead: number
  rowsSkipped: number
  productsCreated: number
  variantsCreated: number
  variantsUpdated: number
  salesCreated: number
  saleLinesCreated: number
  openingStockMovements: number
  dateRange: { from: string; to: string } | null
  issues: { row: number; reason: string }[]
}

export class ImportCommitError extends Error {}

const MAX_ISSUES = 100

function emptyResult(): ImportResult {
  return {
    rowsRead: 0,
    rowsSkipped: 0,
    productsCreated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    salesCreated: 0,
    saleLinesCreated: 0,
    openingStockMovements: 0,
    dateRange: null,
    issues: [],
  }
}

/**
 * Deterministic UUID from the file hash plus a per-sale key, used as
 * `client_sale_id`. Re-importing the same file therefore collides with the
 * existing unique index from migration 0018 rather than duplicating a sale —
 * the same guarantee offline replay relies on, reused rather than reinvented.
 */
function deterministicSaleId(fileHash: string, receiptKey: string): string {
  const digest = createHash('sha256').update(`${fileHash}:${receiptKey}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Supplier price lists spell units every possible way ("KG", "Kgs", "Ltr",
 * "pcs"). Map what we recognise onto the enum 0031 allows and fall back to
 * 'piece' — the same default an unspecified variant already gets — rather than
 * failing the whole import over a unit column.
 */
const UNIT_ALIASES: Record<string, string> = {
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', nos: 'piece', unit: 'piece', ea: 'piece', each: 'piece',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'gram', gm: 'gram', gms: 'gram', gram: 'gram', grams: 'gram',
  l: 'litre', ltr: 'litre', ltrs: 'litre', litre: 'litre', litres: 'litre', liter: 'litre', liters: 'litre',
  ml: 'ml', mls: 'ml', millilitre: 'ml', milliliter: 'ml',
  m: 'metre', mtr: 'metre', metre: 'metre', metres: 'metre', meter: 'metre', meters: 'metre',
  box: 'box', boxes: 'box', ctn: 'box', carton: 'box',
  pack: 'pack', packs: 'pack', pkt: 'pack', packet: 'pack',
  set: 'set', sets: 'set',
  pair: 'pair', pairs: 'pair',
}

function normaliseUnit(raw: string | undefined): string {
  const key = (raw ?? '').trim().toLowerCase()
  return UNIT_ALIASES[key] ?? 'piece'
}

/**
 * Keeps only a structurally plausible EAN/UPC. Strips separators a spreadsheet
 * may have introduced; anything else becomes null rather than poisoning the
 * per-tenant unique barcode index with junk.
 */
function normaliseBarcode(raw: string | undefined): string | null {
  const digits = (raw ?? '').trim().replace(/[\s-]/g, '')
  return /^\d{8,14}$/.test(digits) ? digits : null
}

/** Columns the mapping did not consume, kept verbatim so nothing is lost. */
function sourceMetadata(row: Record<string, string>, mapped: Set<string>): Record<string, string> | null {
  const extras: Record<string, string> = {}
  for (const [column, value] of Object.entries(row)) {
    if (!mapped.has(column) && value !== '') extras[column] = value
  }
  return Object.keys(extras).length > 0 ? extras : null
}

function invertMapping(mappings: ConfirmedMapping[]): Map<string, string> {
  const byTarget = new Map<string, string>()
  for (const mapping of mappings) {
    if (mapping.target && !byTarget.has(mapping.target)) byTarget.set(mapping.target, mapping.column)
  }
  return byTarget
}

export function validateMapping(kind: ImportKind, mappings: ConfirmedMapping[], columns: string[]): string[] {
  const problems: string[] = []
  const known = new Set(columns)
  const validTargets = new Set(targetFieldsFor(kind).map((field) => field.field))
  const seen = new Set<string>()

  for (const mapping of mappings) {
    if (!known.has(mapping.column)) problems.push(`"${mapping.column}" is not a column in this file.`)
    if (mapping.target === null) continue
    if (!validTargets.has(mapping.target)) problems.push(`"${mapping.target}" is not a field we can import into.`)
    if (seen.has(mapping.target)) problems.push(`Two columns are both mapped to "${mapping.target}".`)
    seen.add(mapping.target)
  }

  for (const field of targetFieldsFor(kind)) {
    if (field.required && !seen.has(field.field)) {
      problems.push(`"${field.label}" has no column mapped to it, and the import cannot run without it.`)
    }
  }

  return problems
}

type CommitInput = {
  tenantId: string
  batchId: string
  kind: ImportKind
  fileHash: string
  sourceText: string
  mappings: ConfirmedMapping[]
  createdBy: string | null
  /**
   * Phase 8: which shop the imported history belongs to. Imported stock lands
   * on one shop's shelves and imported sales happened at one shop — there is no
   * meaningful business-wide import, so this is required rather than optional.
   */
  storeId: string
}

export async function commitImport(input: CommitInput): Promise<ImportResult> {
  const parsed = parseCsv(input.sourceText)
  const problems = validateMapping(input.kind, input.mappings, parsed.columns)
  if (problems.length > 0) throw new ImportCommitError(problems.join(' '))

  const byTarget = invertMapping(input.mappings)
  const mappedColumns = new Set(byTarget.values())

  return forTenantTransaction(input.tenantId, async (tx) => {
    const tenant = await tx.tenants.findFirst({
      where: { id: input.tenantId },
      select: { timezone: true },
    })
    const timeZone = tenant?.timezone ?? 'UTC'

    const result =
      input.kind === 'catalog'
        ? await commitCatalog(tx, input, parsed.rows, byTarget, mappedColumns)
        : await commitSales(tx, input, parsed.rows, byTarget, mappedColumns, timeZone)

    await tx.import_batches.update({
      where: { id: input.batchId },
      data: {
        status: 'committed',
        committed_at: new Date(),
        mapping: input.mappings as any,
        summary: result as any,
      },
    })

    return result
  })
}

async function commitCatalog(
  tx: any,
  input: CommitInput,
  rows: Record<string, string>[],
  byTarget: Map<string, string>,
  mappedColumns: Set<string>,
): Promise<ImportResult> {
  const result = emptyResult()
  const value = (row: Record<string, string>, field: string) => {
    const column = byTarget.get(field)
    return column ? (row[column] ?? '').trim() : ''
  }

  const productCache = new Map<string, string>()
  /** Lower-cased category name -> id, so one file resolves each name once. */
  const categoryCache = new Map<string, string>()

  for (const [index, row] of rows.entries()) {
    result.rowsRead += 1
    const rowNumber = index + 2 // +1 for the header, +1 for 1-based rows

    const sku = value(row, 'sku')
    const productName = value(row, 'productName')
    const price = parseNumber(value(row, 'price'))
    const rawTaxRatePercent = value(row, 'taxRatePercent')
    const taxRatePercent = rawTaxRatePercent ? parseNumber(rawTaxRatePercent) : null

    if (!sku || !productName || price === null) {
      result.rowsSkipped += 1
      if (result.issues.length < MAX_ISSUES) {
        result.issues.push({
          row: rowNumber,
          reason: !sku
            ? 'No SKU.'
            : !productName
              ? 'No product name.'
              : `Could not read a price from "${value(row, 'price')}".`,
        })
      }
      continue
    }

    if (
      rawTaxRatePercent &&
      (taxRatePercent === null || taxRatePercent < 0 || taxRatePercent > 100)
    ) {
      result.rowsSkipped += 1
      if (result.issues.length < MAX_ISSUES) {
        result.issues.push({ row: rowNumber, reason: `Could not read an item tax rate between 0 and 100% from "${rawTaxRatePercent}".` })
      }
      continue
    }

    // A supplier file's category text is matched against the tenant's real
    // categories case-insensitively, creating one only when genuinely new.
    // Without this, "DAIRY PRODUCTS" would mint a near-duplicate of "Dairy".
    const categoryName = (value(row, 'category') || '').trim()
    let categoryId: string | null = null
    if (categoryName) {
      const cached = categoryCache.get(categoryName.toLowerCase())
      if (cached) {
        categoryId = cached
      } else {
        const existingCategory = await tx.categories.findFirst({
          where: { name: { equals: categoryName, mode: 'insensitive' } },
          select: { id: true },
        })
        categoryId =
          existingCategory?.id ??
          (
            await tx.categories.create({
              data: { tenant_id: input.tenantId, name: categoryName },
              select: { id: true },
            })
          ).id
        categoryCache.set(categoryName.toLowerCase(), categoryId!)
      }
    }

    let productId = productCache.get(`${productName}::${categoryId ?? ''}`)
    if (!productId) {
      const existing = await tx.products.findFirst({
        where: { tenant_id: input.tenantId, name: productName },
        select: { id: true },
      })
      if (existing) {
        productId = existing.id
      } else {
        const created = await tx.products.create({
          data: { tenant_id: input.tenantId, name: productName, category_id: categoryId },
          select: { id: true },
        })
        productId = created.id
        result.productsCreated += 1
      }
      productCache.set(`${productName}::${categoryId ?? ''}`, productId!)
    }

    const cost = parseNumber(value(row, 'cost'))
    const reorderThreshold = parseNumber(value(row, 'reorderThreshold'))
    // A distributor price list carries the maker's EAN and the pack unit, which
    // is exactly how a supermarket loads Nestlé/ITC/Unilever stock in bulk
    // rather than typing each product in by hand.
    const unitOfMeasure = normaliseUnit(value(row, 'unitOfMeasure'))
    const barcode = normaliseBarcode(value(row, 'barcode'))
    const variantData = {
      product_id: productId!,
      barcode,
      unit_of_measure: unitOfMeasure,
      size: value(row, 'size') || null,
      color: value(row, 'color') || null,
      material: value(row, 'material') || null,
      price: price.toFixed(2),
      // An omitted tax column must not erase a rate already configured on an
      // existing SKU. Explicit 0 is preserved as a genuine zero-rate item.
      tax_rate: taxRatePercent === null ? undefined : (taxRatePercent / 100).toFixed(4),
      moving_average_cost: cost === null ? null : cost.toFixed(2),
      // No longer rounded: a kg variant legitimately reorders at 5.5 (0031).
      reorder_threshold: reorderThreshold === null ? undefined : Math.max(0, reorderThreshold),
      source_metadata: sourceMetadata(row, mappedColumns) as any,
    }

    const existingVariant = await tx.variants.findFirst({
      where: { tenant_id: input.tenantId, sku },
      select: { id: true },
    })

    let variantId: string
    if (existingVariant) {
      await tx.variants.update({ where: { id: existingVariant.id }, data: variantData })
      variantId = existingVariant.id
      result.variantsUpdated += 1
    } else {
      const created = await tx.variants.create({
        data: { tenant_id: input.tenantId, sku, ...variantData },
        select: { id: true },
      })
      variantId = created.id
      result.variantsCreated += 1
    }

    // Opening stock is written as a `receive` movement, not by setting a level:
    // current stock is trigger-derived from the append-only ledger and is never
    // mutated directly (migration 0008).
    const quantity = parseNumber(value(row, 'quantityOnHand'))
    if (quantity !== null && quantity > 0) {
      await tx.stock_movements.create({
        data: {
          tenant_id: input.tenantId,
          store_id: input.storeId,
          variant_id: variantId,
          movement_type: 'receive',
          // Not rounded: 12.5 kg of opening stock must land as 12.5 (0031).
          quantity_delta: quantity,
          reason_note: `Opening stock from import ${input.batchId}`,
          created_by: input.createdBy,
        },
      })
      result.openingStockMovements += 1
    }
  }

  return result
}

type PendingLine = {
  rowNumber: number
  variantId: string
  quantity: number
  unitPrice: number
  lineTotal: number
  discount: number
  isTaxable: boolean
  taxRate: string | null
}

async function commitSales(
  tx: any,
  input: CommitInput,
  rows: Record<string, string>[],
  byTarget: Map<string, string>,
  mappedColumns: Set<string>,
  timeZone: string,
): Promise<ImportResult> {
  const result = emptyResult()
  const value = (row: Record<string, string>, field: string) => {
    const column = byTarget.get(field)
    return column ? (row[column] ?? '').trim() : ''
  }

  // Day-first vs month-first is decided once for the whole column — see
  // detectDateOrder. Deciding per value would scatter one column across two
  // calendars and put rollup rows on the wrong business day.
  const dateColumn = byTarget.get('soldAt')!
  const order: DateOrder = detectDateOrder(rows.map((row) => row[dateColumn] ?? ''))

  type PendingSale = {
    receiptKey: string
    soldAt: Date
    lines: PendingLine[]
    metadata: Record<string, string> | null
    taxAmount: number
    customerEmail: string | null
    customerName: string | null
  }

  const sales = new Map<string, PendingSale>()
  const variantCache = new Map<string, { id: string; price: string; is_taxable: boolean; tax_rate: unknown } | null>()

  for (const [index, row] of rows.entries()) {
    result.rowsRead += 1
    const rowNumber = index + 2

    const receiptKey = value(row, 'receiptNumber')
    const rawDate = value(row, 'soldAt')
    const sku = value(row, 'sku')
    const quantity = parseNumber(value(row, 'quantity'))
    const soldAt = rawDate ? parseDateInZone(rawDate, order, timeZone) : null

    if (!receiptKey || !soldAt || !sku || quantity === null || Math.round(quantity) <= 0) {
      result.rowsSkipped += 1
      if (result.issues.length < MAX_ISSUES) {
        result.issues.push({
          row: rowNumber,
          reason: !receiptKey
            ? 'No receipt number, so the line cannot be attached to a sale.'
            : !soldAt
              ? `Could not read a date from "${rawDate}".`
              : !sku
                ? 'No SKU.'
                : `Could not read a positive quantity from "${value(row, 'quantity')}".`,
        })
      }
      continue
    }

    if (!variantCache.has(sku)) {
      variantCache.set(
        sku,
        await tx.variants.findFirst({
          where: { tenant_id: input.tenantId, sku },
          select: { id: true, price: true, is_taxable: true, tax_rate: true },
        }),
      )
    }
    const variant = variantCache.get(sku)
    if (!variant) {
      result.rowsSkipped += 1
      if (result.issues.length < MAX_ISSUES) {
        result.issues.push({
          row: rowNumber,
          reason: `SKU "${sku}" is not in the catalog. Import the catalog first, then this file.`,
        })
      }
      continue
    }

    const qty = Math.round(quantity)
    const discount = parseNumber(value(row, 'discountAmount')) ?? 0
    const unitPrice = parseNumber(value(row, 'unitPrice'))
    const lineTotalRaw = parseNumber(value(row, 'lineTotal'))
    // Whichever of the two the file has, derive the other. A file with both
    // keeps both as given — we record what the old system recorded.
    const resolvedUnitPrice =
      unitPrice ?? (lineTotalRaw !== null ? (lineTotalRaw + discount) / qty : Number(variant.price))
    const lineTotal = lineTotalRaw ?? resolvedUnitPrice * qty - discount

    const existing = sales.get(receiptKey)
    const line: PendingLine = {
      rowNumber,
      variantId: variant.id,
      quantity: qty,
      unitPrice: resolvedUnitPrice,
      lineTotal,
      discount,
      isTaxable: variant.is_taxable,
      taxRate: variant.tax_rate == null ? null : String(variant.tax_rate),
    }

    if (existing) {
      existing.lines.push(line)
      existing.taxAmount += parseNumber(value(row, 'taxAmount')) ?? 0
    } else {
      sales.set(receiptKey, {
        receiptKey,
        soldAt,
        lines: [line],
        metadata: sourceMetadata(row, mappedColumns),
        taxAmount: parseNumber(value(row, 'taxAmount')) ?? 0,
        customerEmail: value(row, 'customerEmail') || null,
        customerName: value(row, 'customerName') || null,
      })
    }
  }

  let earliest: Date | null = null
  let latest: Date | null = null

  for (const sale of sales.values()) {
    const subtotal = sale.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
    const discount = sale.lines.reduce((sum, line) => sum + line.discount, 0)
    const total = sale.lines.reduce((sum, line) => sum + line.lineTotal, 0) + sale.taxAmount

    const clientSaleId = deterministicSaleId(input.fileHash, sale.receiptKey)
    const created = await tx.sales.create({
      data: {
        tenant_id: input.tenantId,
        store_id: input.storeId,
        client_sale_id: clientSaleId,
        subtotal: subtotal.toFixed(2),
        discount_amount: discount.toFixed(2),
        tax_amount: sale.taxAmount.toFixed(2),
        total_amount: total.toFixed(2),
        status: 'completed',
        source: 'import',
        source_metadata: sale.metadata as any,
        import_batch_id: input.batchId,
        // The rollup trigger buckets on this value in the tenant's timezone,
        // so an imported sale must carry the instant it actually happened.
        created_at: sale.soldAt,
        created_by: input.createdBy,
      },
      select: { id: true },
    })
    result.salesCreated += 1

    for (const line of sale.lines) {
      await tx.sale_line_items.create({
        data: {
          tenant_id: input.tenantId,
          sale_id: created.id,
          variant_id: line.variantId,
          quantity: line.quantity,
          unit_price: line.unitPrice.toFixed(2),
          discount_amount: line.discount.toFixed(2),
          is_taxable: line.isTaxable,
          tax_rate: line.taxRate,
          line_total: line.lineTotal.toFixed(2),
          created_at: sale.soldAt,
        },
      })
      result.saleLinesCreated += 1
    }

    // A single payment row keeps the 0016 sum guard satisfied. Historical
    // tender type is rarely reliable in an export, so it is recorded as cash
    // with the source note rather than guessed per row.
    await tx.payments.create({
      data: {
        tenant_id: input.tenantId,
        sale_id: created.id,
        method: 'cash',
        direction: 'payment',
        amount: total.toFixed(2),
        reference_code: `import:${sale.receiptKey}`.slice(0, 100),
        created_by: input.createdBy,
      },
    })

    // Deliberately NO stock movements. These sales already happened; the stock
    // they consumed is already absent from the shelves the owner counted when
    // they entered opening stock. Writing sale movements here would deplete
    // current inventory a second time.

    if (!earliest || sale.soldAt < earliest) earliest = sale.soldAt
    if (!latest || sale.soldAt > latest) latest = sale.soldAt
  }

  if (earliest && latest) {
    result.dateRange = { from: earliest.toISOString(), to: latest.toISOString() }
  }

  return result
}

export function hashFile(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function newBatchId(): string {
  return randomUUID()
}
