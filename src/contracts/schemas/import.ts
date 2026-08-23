import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export const ImportKindSchema = z.enum(['catalog', 'sales']).openapi('ImportKind')

/**
 * The fields an import can write to. Everything else in the file is preserved
 * in `source_metadata` rather than discarded (ONBOARD-03), so this  list is
 * deliberately small — it covers what the POS can act on, not everything a
 * previous system happened to store.
 */
export const CATALOG_TARGET_FIELDS = [
  { field: 'sku', label: 'SKU', required: true, type: 'text', hint: 'Unique product code. Rows without one cannot be imported.' },
  { field: 'productName', label: 'Product name', required: true, type: 'text', hint: 'Shown on the till and on receipts.' },
  { field: 'category', label: 'Category', required: false, type: 'text', hint: 'Groups products in reports.' },
  { field: 'barcode', label: 'Barcode (EAN/UPC)', required: false, type: 'text', hint: "The manufacturer's printed barcode. Lets the till find this item by scanning it." },
  { field: 'unitOfMeasure', label: 'Unit', required: false, type: 'text', hint: 'How this item is sold — piece, kg, litre, pack. Defaults to piece.' },
  { field: 'size', label: 'Size', required: false, type: 'text', hint: '' },
  { field: 'color', label: 'Colour', required: false, type: 'text', hint: '' },
  { field: 'material', label: 'Material', required: false, type: 'text', hint: '' },
  { field: 'price', label: 'Selling price', required: true, type: 'number', hint: 'What the customer pays.' },
  { field: 'taxRatePercent', label: 'Item tax rate (%)', required: false, type: 'number', hint: 'The rate saved on this sellable SKU. Leave blank only for legacy store fallback.' },
  { field: 'cost', label: 'Unit cost', required: false, type: 'number', hint: 'Sets the opening cost basis for gross margin.' },
  { field: 'quantityOnHand', label: 'Quantity on hand', required: false, type: 'number', hint: 'Written as an opening stock receipt.' },
  { field: 'reorderThreshold', label: 'Reorder point', required: false, type: 'number', hint: 'Drives the low-stock alert.' },
] as const

export const SALES_TARGET_FIELDS = [
  { field: 'receiptNumber', label: 'Receipt / invoice number', required: true, type: 'text', hint: 'Lines sharing one value become one sale.' },
  { field: 'soldAt', label: 'Date sold', required: true, type: 'date', hint: 'Read in your store timezone. Wrong dates put history on the wrong day.' },
  { field: 'sku', label: 'SKU', required: true, type: 'text', hint: 'Must match a product already in the catalog.' },
  { field: 'quantity', label: 'Quantity', required: true, type: 'number', hint: '' },
  { field: 'unitPrice', label: 'Unit price', required: false, type: 'number', hint: 'Derived from the line total if absent.' },
  { field: 'lineTotal', label: 'Line total', required: false, type: 'number', hint: 'Derived from price × quantity if absent.' },
  { field: 'discountAmount', label: 'Line discount', required: false, type: 'number', hint: '' },
  { field: 'taxAmount', label: 'Tax amount', required: false, type: 'number', hint: 'Recorded on the sale, not recalculated.' },
  { field: 'paymentMethod', label: 'Payment method', required: false, type: 'text', hint: 'Falls back to cash when unreadable.' },
  { field: 'customerName', label: 'Customer name', required: false, type: 'text', hint: '' },
  { field: 'customerEmail', label: 'Customer email', required: false, type: 'text', hint: '' },
] as const

export type TargetFieldDefinition = {
  field: string
  label: string
  required: boolean
  type: 'text' | 'number' | 'date'
  hint: string
}

export function targetFieldsFor(kind: 'catalog' | 'sales'): readonly TargetFieldDefinition[] {
  return kind === 'catalog' ? CATALOG_TARGET_FIELDS : SALES_TARGET_FIELDS
}

export const TargetFieldSchema = z
  .object({
    field: z.string(),
    label: z.string(),
    required: z.boolean(),
    type: z.enum(['text', 'number', 'date']),
    hint: z.string(),
  })
  .openapi('ImportTargetField')

export const UploadImportSchema = z
  .object({
    kind: ImportKindSchema,
    fileName: z.string().trim().min(1).max(255),
    /** Base64 of the raw file bytes. Hashed before decoding, so the hash is of what was actually uploaded. */
    contentBase64: z.string().min(1),
  })
  .strict()
  .openapi('UploadImportRequest')

export const ImportColumnPreviewSchema = z
  .object({
    name: z.string(),
    /** A few real values from the file — never invented samples. */
    samples: z.array(z.string()),
    nonEmptyCount: z.number().int().min(0),
  })
  .openapi('ImportColumnPreview')

export const ImportBatchSchema = z
  .object({
    id: z.string().uuid(),
    kind: ImportKindSchema,
    fileName: z.string(),
    fileHash: z.string(),
    status: z.enum(['pending', 'committed', 'failed']),
    rowCount: z.number().int().min(0),
    columns: z.array(ImportColumnPreviewSchema),
    sampleRows: z.array(z.record(z.string(), z.string())),
    delimiter: z.string(),
    encoding: z.string(),
    blankRowsSkipped: z.number().int().min(0),
    raggedRows: z.number().int().min(0),
    targetFields: z.array(TargetFieldSchema),
    committedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    summary: z.unknown().nullable(),
  })
  .openapi('ImportBatch')

export const MappingConfidenceSchema = z.enum(['high', 'medium', 'low']).openapi('ImportMappingConfidence')

export const ColumnMappingSchema = z
  .object({
    column: z.string(),
    /** null means "leave unmapped" — preserved in source_metadata, not dropped. */
    target: z.string().nullable(),
    confidence: MappingConfidenceSchema,
    reason: z.string(),
  })
  .openapi('ImportColumnMapping')

export const MappingSuggestionSchema = z
  .object({
    mappings: z.array(ColumnMappingSchema),
    /** How the suggestion was produced, so the screen can say so honestly. */
    source: z.enum(['claude', 'heuristic']),
    /** Present when the AI suggestion could not be obtained and the fallback ran. */
    note: z.string().nullable(),
  })
  .openapi('ImportMappingSuggestion')

export const CommitImportSchema = z
  .object({
    /** The owner-confirmed mapping. Suggestions are never committed unreviewed. */
    mappings: z.array(
      z.object({ column: z.string(), target: z.string().nullable() }).strict(),
    ),
  })
  .strict()
  .openapi('CommitImportRequest')

export const ImportCommitResultSchema = z
  .object({
    batch: ImportBatchSchema,
    result: z.object({
      rowsRead: z.number().int().min(0),
      rowsSkipped: z.number().int().min(0),
      productsCreated: z.number().int().min(0),
      variantsCreated: z.number().int().min(0),
      variantsUpdated: z.number().int().min(0),
      salesCreated: z.number().int().min(0),
      saleLinesCreated: z.number().int().min(0),
      openingStockMovements: z.number().int().min(0),
      dateRange: z.object({ from: z.string(), to: z.string() }).nullable(),
      /** Row-level problems, reported rather than hidden behind a success count. */
      issues: z.array(z.object({ row: z.number().int(), reason: z.string() })),
    }),
  })
  .openapi('ImportCommitResult')

export const ImportBatchListSchema = z
  .object({ batches: z.array(ImportBatchSchema) })
  .openapi('ImportBatchList')

export type ImportKind = z.infer<typeof ImportKindSchema>
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>
export type MappingSuggestion = z.infer<typeof MappingSuggestionSchema>
