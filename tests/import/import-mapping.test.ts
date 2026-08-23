import { describe, expect, it } from 'vitest'
import { heuristicMapping } from '../../src/services/import-mapping'
import { validateMapping } from '../../src/services/import-commit'

describe('heuristicMapping', () => {
  it('matches the header names a real catalog export uses', () => {
    const mappings = heuristicMapping({
      kind: 'catalog',
      columns: ['Item Code', 'Product Name', 'MRP', 'GST Rate', 'Closing Stock', 'Supplier Notes'],
      rows: [{ 'Item Code': 'A-1', 'Product Name': 'Shirt', MRP: '1299', 'GST Rate': '5', 'Closing Stock': '4', 'Supplier Notes': 'x' }],
    })

    const byColumn = Object.fromEntries(mappings.map((m) => [m.column, m.target]))
    expect(byColumn['Item Code']).toBe('sku')
    expect(byColumn['Product Name']).toBe('productName')
    expect(byColumn['MRP']).toBe('price')
    expect(byColumn['GST Rate']).toBe('taxRatePercent')
    expect(byColumn['Closing Stock']).toBe('quantityOnHand')
  })

  it('leaves an unrecognised column unmapped rather than guessing', () => {
    const mappings = heuristicMapping({
      kind: 'catalog',
      columns: ['Supplier Notes'],
      rows: [{ 'Supplier Notes': 'anything' }],
    })

    expect(mappings[0].target).toBeNull()
    expect(mappings[0].confidence).toBe('low')
    expect(mappings[0].reason).toContain('preserved')
  })

  it('never assigns one target field to two columns', () => {
    const mappings = heuristicMapping({
      kind: 'sales',
      columns: ['Qty', 'Quantity'],
      rows: [{ Qty: '1', Quantity: '1' }],
    })

    const targets = mappings.map((m) => m.target).filter(Boolean)
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('returns exactly one entry per source column', () => {
    const columns = ['A', 'B', 'C', 'SKU', 'Name', 'Price']
    const mappings = heuristicMapping({ kind: 'catalog', columns, rows: [] })
    expect(mappings.map((m) => m.column)).toEqual(columns)
  })
})

describe('validateMapping', () => {
  const columns = ['SKU', 'Name', 'Price', 'Notes']

  it('accepts a mapping that covers every required field', () => {
    const problems = validateMapping(
      'catalog',
      [
        { column: 'SKU', target: 'sku' },
        { column: 'Name', target: 'productName' },
        { column: 'Price', target: 'price' },
        { column: 'Notes', target: null },
      ],
      columns,
    )
    expect(problems).toEqual([])
  })

  it('refuses an import missing a required field', () => {
    const problems = validateMapping(
      'catalog',
      [
        { column: 'SKU', target: 'sku' },
        { column: 'Name', target: 'productName' },
      ],
      columns,
    )
    expect(problems.join(' ')).toContain('Selling price')
  })

  it('refuses two columns mapped to the same field', () => {
    const problems = validateMapping(
      'catalog',
      [
        { column: 'SKU', target: 'sku' },
        { column: 'Name', target: 'productName' },
        { column: 'Price', target: 'price' },
        { column: 'Notes', target: 'price' },
      ],
      columns,
    )
    expect(problems.join(' ')).toContain('both mapped to "price"')
  })

  it('refuses a column that is not in the file', () => {
    const problems = validateMapping('catalog', [{ column: 'Ghost', target: 'sku' }], columns)
    expect(problems.join(' ')).toContain('not a column in this file')
  })
})
