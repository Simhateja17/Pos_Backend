import Anthropic from '@anthropic-ai/sdk'
import {
  type ColumnMapping,
  type ImportKind,
  type MappingSuggestion,
  targetFieldsFor,
} from '../contracts/schemas/import'

/**
 * ONBOARD-03 — propose source-column → target-field mappings.
 *
 * This service only ever *suggests*. Nothing it returns is written anywhere:
 * the owner reviews and confirms, and the commit route reads the confirmed
 * mapping from the request, never from here. That boundary is the whole point
 * of the requirement — a model that maps "Amount" to the wrong field across
 * 40,000 rows is unrecoverable without it.
 *
 * Low-confidence proposals default to unmapped rather than to a guess. An
 * unmapped column is preserved in `source_metadata` and can be corrected in
 * seconds; a confidently wrong mapping is silent.
 */

const MODEL = 'claude-opus-5'
const SAMPLE_ROWS = 5

export type MappingInput = {
  kind: ImportKind
  columns: string[]
  rows: Record<string, string>[]
}

/**
 * Header-similarity fallback. Runs when no API key is configured or the model
 * call fails, so an import is never blocked on a third-party service — and the
 * result is labelled 'heuristic' so the screen can say which produced it.
 */
const SYNONYMS: Record<string, string[]> = {
  sku: ['sku', 'itemcode', 'item code', 'productcode', 'product code', 'barcode', 'code', 'article', 'style'],
  productName: ['name', 'product', 'productname', 'product name', 'item', 'itemname', 'description', 'particulars'],
  category: ['category', 'department', 'group', 'productgroup', 'class', 'type'],
  size: ['size'],
  color: ['color', 'colour', 'shade'],
  material: ['material', 'fabric', 'composition'],
  price: ['price', 'sellingprice', 'selling price', 'mrp', 'rate', 'unitprice', 'unit price', 'retail'],
  cost: ['cost', 'costprice', 'cost price', 'purchaseprice', 'purchase price', 'landedcost', 'buyprice'],
  quantityOnHand: ['qty', 'quantity', 'stock', 'onhand', 'on hand', 'closingstock', 'closing stock', 'balance'],
  reorderThreshold: ['reorder', 'reorderlevel', 'reorder level', 'reorderpoint', 'minstock', 'min stock', 'minimum'],
  receiptNumber: ['receipt', 'receiptno', 'receipt no', 'invoice', 'invoiceno', 'invoice no', 'bill', 'billno', 'billnumber', 'order', 'orderid', 'transaction', 'transactionid'],
  soldAt: ['date', 'datetime', 'solddate', 'sold date', 'invoicedate', 'invoice date', 'billdate', 'transactiondate', 'timestamp', 'time'],
  quantity: ['qty', 'quantity', 'units', 'qtysold', 'quantitysold'],
  unitPrice: ['unitprice', 'unit price', 'rate', 'price', 'sellingprice'],
  lineTotal: ['total', 'linetotal', 'line total', 'amount', 'nettotal', 'net amount', 'value', 'subtotal'],
  discountAmount: ['discount', 'discountamount', 'disc', 'discvalue'],
  taxAmount: ['tax', 'gst', 'vat', 'taxamount', 'salestax'],
  paymentMethod: ['payment', 'paymentmethod', 'payment mode', 'paymode', 'tender', 'mode'],
  customerName: ['customer', 'customername', 'customer name', 'client', 'buyer', 'party'],
  customerEmail: ['email', 'customeremail', 'customer email', 'emailid', 'mail'],
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function heuristicMapping(input: MappingInput): ColumnMapping[] {
  const targets = targetFieldsFor(input.kind)
  const claimed = new Set<string>()

  return input.columns.map((column) => {
    const normalised = normalise(column)

    for (const target of targets) {
      if (claimed.has(target.field)) continue
      const synonyms = SYNONYMS[target.field] ?? []
      const exact = normalise(target.field) === normalised || synonyms.some((s) => normalise(s) === normalised)
      if (exact) {
        claimed.add(target.field)
        return {
          column,
          target: target.field,
          confidence: 'high' as const,
          reason: `Header matches "${target.label}".`,
        }
      }
    }

    for (const target of targets) {
      if (claimed.has(target.field)) continue
      const synonyms = SYNONYMS[target.field] ?? []
      const partial = synonyms.some((s) => normalised.includes(normalise(s)) || normalise(s).includes(normalised))
      if (partial && normalised.length > 2) {
        claimed.add(target.field)
        return {
          column,
          target: target.field,
          confidence: 'medium' as const,
          reason: `Header looks like "${target.label}" — confirm before importing.`,
        }
      }
    }

    return {
      column,
      target: null,
      confidence: 'low' as const,
      reason: 'No confident match. Left unmapped — the column is still preserved with the imported rows.',
    }
  })
}

function buildPrompt(input: MappingInput): string {
  const targets = targetFieldsFor(input.kind)
  const sample = input.rows.slice(0, SAMPLE_ROWS)

  const columnBlock = input.columns
    .map((column) => {
      const values = sample.map((row) => row[column] ?? '').filter((value) => value !== '')
      return `- ${JSON.stringify(column)} → sample values: ${values.length ? values.map((v) => JSON.stringify(v)).join(', ') : '(all blank in the sample)'}`
    })
    .join('\n')

  const targetBlock = targets
    .map((target) => `- ${target.field} (${target.label}, ${target.type}${target.required ? ', required' : ''})${target.hint ? ` — ${target.hint}` : ''}`)
    .join('\n')

  return [
    `A retailer is migrating ${input.kind === 'catalog' ? 'their product catalog' : 'their sales history'} from another point-of-sale system into ours. Map each column of their export to one of our fields.`,
    '',
    'Their columns and real sample values:',
    columnBlock,
    '',
    'Our target fields:',
    targetBlock,
    '',
    'Rules:',
    '- Each target field may be used at most once. Every source column gets exactly one entry.',
    '- Judge by the sample values, not the header alone. A header reading "Amount" over values like "2" is a quantity, not money.',
    '- If you are not confident, set target to null. An unmapped column is preserved and easy for the owner to fix; a wrong mapping is applied silently to every row.',
    '- confidence: "high" only when the header and the values both agree; "medium" when plausible but worth a look; "low" when you are guessing (pair with target null).',
    '- reason: one short sentence a shop owner would understand, naming the evidence you used.',
  ].join('\n')
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          target: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
        },
        required: ['column', 'target', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['mappings'],
  additionalProperties: false,
} as const

/**
 * Reconcile a model response against the actual columns: every column must
 * appear exactly once, unknown target names are dropped, and a target claimed
 * twice keeps only its first use. A malformed suggestion becomes an unmapped
 * column, never a silently missing one.
 */
function reconcile(input: MappingInput, proposed: ColumnMapping[]): ColumnMapping[] {
  const validTargets = new Set(targetFieldsFor(input.kind).map((target) => target.field))
  const byColumn = new Map(proposed.map((mapping) => [mapping.column, mapping]))
  const claimed = new Set<string>()

  return input.columns.map((column) => {
    const mapping = byColumn.get(column)
    if (!mapping) {
      return {
        column,
        target: null,
        confidence: 'low' as const,
        reason: 'No suggestion was returned for this column. Map it yourself, or leave it — it is preserved either way.',
      }
    }

    const target = mapping.target
    const usable = target !== null && validTargets.has(target) && !claimed.has(target)
    // A low-confidence suggestion is deliberately downgraded to unmapped.
    const keep = usable && mapping.confidence !== 'low'
    if (keep && target) claimed.add(target)

    return {
      column,
      target: keep ? target : null,
      confidence: mapping.confidence,
      reason: keep
        ? mapping.reason
        : target === null
          ? mapping.reason
          : 'Suggested with low confidence, so it is left unmapped rather than guessed.',
    }
  })
}

export async function suggestMapping(input: MappingInput): Promise<MappingSuggestion> {
  if (input.columns.length === 0) {
    return { mappings: [], source: 'heuristic', note: 'The file has no columns to map.' }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      mappings: heuristicMapping(input),
      source: 'heuristic',
      note: 'AI mapping is not configured on this server, so these came from header matching. Check every row carefully.',
    }
  }

  try {
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      // A short, well-specified classification — low effort keeps latency and
      // cost down without hurting quality on a task this bounded.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      messages: [{ role: 'user', content: buildPrompt(input) }],
    })

    if (response.stop_reason === 'refusal') {
      throw new Error('The mapping request was declined.')
    }

    const text = response.content.find((block) => block.type === 'text')
    if (!text || text.type !== 'text') {
      throw new Error('The model returned no mapping.')
    }

    const parsed = JSON.parse(text.text) as { mappings: ColumnMapping[] }
    return { mappings: reconcile(input, parsed.mappings ?? []), source: 'claude', note: null }
  } catch (error) {
    return {
      mappings: heuristicMapping(input),
      source: 'heuristic',
      note: `AI mapping was unavailable (${error instanceof Error ? error.message : 'unknown error'}), so these came from header matching. Check every row carefully.`,
    }
  }
}
