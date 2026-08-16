import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseImportFile } from '../../src/services/import-file-parse'

function workbookBuffer(bookType: 'xls' | 'xlsx', sheets: Record<string, unknown[][]>): Buffer {
  const workbook = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return XLSX.write(workbook, { bookType, type: 'buffer' }) as Buffer
}

describe('parseImportFile', () => {
  it.each(['xlsx', 'xls'] as const)('normalizes a %s workbook into the import row shape', (format) => {
    const parsed = parseImportFile(
      workbookBuffer(format, {
        Products: [
          ['SKU', 'Product Name', 'Price'],
          ['A-1', 'Kurta, blue', 1299],
          ['A-2', 'Café dress', 2499.5],
        ],
      }),
      `catalog.${format}`,
    )

    expect(parsed.format).toBe(format)
    expect(parsed.encoding).toBe(`excel-${format}`)
    expect(parsed.columns).toEqual(['SKU', 'Product Name', 'Price'])
    expect(parsed.rows).toEqual([
      { SKU: 'A-1', 'Product Name': 'Kurta, blue', Price: '1299' },
      { SKU: 'A-2', 'Product Name': 'Café dress', Price: '2499.5' },
    ])
    expect(parsed.sourceText).toContain('SKU,Product Name,Price')
  })

  it('uses the first non-empty worksheet and does not concatenate unrelated tabs', () => {
    const parsed = parseImportFile(
      workbookBuffer('xlsx', {
        Cover: [['This is a title sheet']],
        Products: [
          ['SKU', 'Name', 'Price'],
          ['A-1', 'Shirt', 999],
        ],
        Notes: [['Do not import this tab']],
      }),
      'catalog.xlsx',
    )

    expect(parsed.columns).toEqual(['SKU', 'Name', 'Price'])
    expect(parsed.rows).toEqual([{ SKU: 'A-1', Name: 'Shirt', Price: '999' }])
  })

  it('keeps CSV uploads on the existing parser path', () => {
    const parsed = parseImportFile(Buffer.from('SKU,Name\nA-1,Shirt\n', 'utf8'), 'catalog.csv')

    expect(parsed.format).toBe('csv')
    expect(parsed.encoding).toBe('utf-8')
    expect(parsed.rows).toEqual([{ SKU: 'A-1', Name: 'Shirt' }])
    expect(parsed.sourceText).toBe('SKU,Name\nA-1,Shirt\n')
  })
})
