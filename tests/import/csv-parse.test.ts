import { describe, expect, it } from 'vitest'
import {
  CsvParseError,
  MAX_FILE_BYTES,
  decodeCsvBuffer,
  detectDateOrder,
  detectDelimiter,
  parseCsv,
  parseCsvUpload,
  parseDateInZone,
  parseNumber,
} from '../../src/services/csv-parse'

describe('decodeCsvBuffer', () => {
  it('strips a UTF-8 BOM so the first header is not named "\\ufeffSKU"', () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('SKU,Name\nA-1,Shirt\n', 'utf8')])
    const { text, encoding } = decodeCsvBuffer(buffer)

    expect(encoding).toBe('utf-8-bom')
    expect(text.startsWith('SKU')).toBe(true)
    expect(parseCsv(text).columns).toEqual(['SKU', 'Name'])
  })

  it('falls back to Windows-1252 rather than corrupting accented names', () => {
    // 0xE9 is "é" in Windows-1252 and an invalid lone byte in UTF-8.
    const buffer = Buffer.concat([Buffer.from('Name\nCaf', 'latin1'), Buffer.from([0xe9]), Buffer.from('\n', 'latin1')])
    const { text, encoding } = decodeCsvBuffer(buffer)

    expect(encoding).toBe('windows-1252')
    expect(text).toContain('Café')
  })

  it('refuses a file over the size cap instead of trying to hold it in memory', () => {
    expect(() => decodeCsvBuffer(Buffer.alloc(MAX_FILE_BYTES + 1))).toThrow(CsvParseError)
  })
})

describe('detectDelimiter', () => {
  it('ignores delimiters inside quotes when choosing', () => {
    expect(detectDelimiter('SKU;Customer;Total')).toBe(';')
    expect(detectDelimiter('SKU;"Smith, John, Jr";Total')).toBe(';')
    expect(detectDelimiter('SKU\tName\tTotal')).toBe('\t')
    expect(detectDelimiter('SKU,Name,Total')).toBe(',')
  })
})

describe('parseCsv', () => {
  it('keeps quoted commas and embedded newlines in one field', () => {
    const parsed = parseCsv('SKU,Name,Note\nA-1,"Shirt, blue","line one\nline two"\n')

    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0].Name).toBe('Shirt, blue')
    expect(parsed.rows[0].Note).toBe('line one\nline two')
  })

  it('unescapes doubled quotes', () => {
    const parsed = parseCsv('SKU,Name\nA-1,"12"" Pan"\n')
    expect(parsed.rows[0].Name).toBe('12" Pan')
  })

  it('reports trailing blank rows rather than silently eating them', () => {
    const parsed = parseCsv('SKU,Name\r\nA-1,Shirt\r\n,\r\n\r\n')

    expect(parsed.rows).toHaveLength(1)
    expect(parsed.blankRowsSkipped).toBe(2)
  })

  it('names empty header cells instead of dropping their column', () => {
    const parsed = parseCsv('SKU,,Name\nA-1,X,Shirt\n')

    expect(parsed.columns).toEqual(['SKU', 'Column 2', 'Name'])
    expect(parsed.rows[0]['Column 2']).toBe('X')
  })

  it('disambiguates duplicate headers so neither column is overwritten', () => {
    const parsed = parseCsv('Total,Total\n10,20\n')

    expect(parsed.columns).toEqual(['Total', 'Total (2)'])
    expect(parsed.rows[0]).toEqual({ Total: '10', 'Total (2)': '20' })
  })

  it('pads a short row and counts it as ragged', () => {
    const parsed = parseCsv('SKU,Name,Price\nA-1,Shirt\n')

    expect(parsed.raggedRows).toBe(1)
    expect(parsed.rows[0].Price).toBe('')
  })

  it('refuses a file over the row cap', () => {
    const text = `SKU\n${Array.from({ length: 12 }, (_, i) => `A-${i}`).join('\n')}\n`
    expect(() => parseCsv(text, { maxRows: 10 })).toThrow(/more than 10 rows/)
  })

  it('parses a semicolon export end to end from raw bytes', () => {
    const parsed = parseCsvUpload(Buffer.from('SKU;Name;Amount\nA-1;"Shirt; blue";1.234,56\n', 'utf8'))

    expect(parsed.delimiter).toBe(';')
    expect(parsed.rows[0].Name).toBe('Shirt; blue')
    expect(parseNumber(parsed.rows[0].Amount)).toBe(1234.56)
  })
})

describe('parseNumber', () => {
  it.each([
    ['1,23,456.78', 123456.78],
    ['123,456.78', 123456.78],
    ['1.234,56', 1234.56],
    ['₹ 1,299.00', 1299],
    ['$1,299', 1299],
    ['(45.50)', -45.5],
    ['-45.50', -45.5],
    ['42', 42],
    ['0', 0],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected)
  })

  it('returns null for unreadable input rather than zero', () => {
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('n/a')).toBeNull()
    expect(parseNumber('  ')).toBeNull()
  })
})

describe('date handling', () => {
  it('resolves day-first vs month-first across the whole column', () => {
    expect(detectDateOrder(['01/02/2026', '13/02/2026'])).toBe('dmy')
    expect(detectDateOrder(['01/02/2026', '02/28/2026'])).toBe('mdy')
    expect(detectDateOrder(['2026-02-01', '2026-02-13'])).toBe('ymd')
  })

  it('parses the formats a real export mixes', () => {
    const iso = parseDateInZone('2026-03-01 14:30', 'ymd', 'UTC')
    expect(iso?.toISOString()).toBe('2026-03-01T14:30:00.000Z')

    const dmy = parseDateInZone('01/03/2026', 'dmy', 'UTC')
    expect(dmy?.toISOString()).toBe('2026-03-01T00:00:00.000Z')

    const mdy = parseDateInZone('03/01/2026', 'mdy', 'UTC')
    expect(mdy?.toISOString()).toBe('2026-03-01T00:00:00.000Z')

    const named = parseDateInZone('01-Mar-2026', 'dmy', 'UTC')
    expect(named?.toISOString()).toBe('2026-03-01T00:00:00.000Z')

    const meridiem = parseDateInZone('01/03/2026 07:05 PM', 'dmy', 'UTC')
    expect(meridiem?.toISOString()).toBe('2026-03-01T19:05:00.000Z')
  })

  /**
   * The boundary case that decides whether daily_sales_rollup gets the right
   * date. 00:30 on 1 March in Kolkata is 19:00 on 28 February UTC — storing the
   * wall-clock value as UTC would book the sale to the wrong business day.
   */
  it('interprets wall-clock values in the tenant timezone, not UTC', () => {
    const kolkata = parseDateInZone('01/03/2026 00:30', 'dmy', 'Asia/Kolkata')
    expect(kolkata?.toISOString()).toBe('2026-02-28T19:00:00.000Z')

    const newYork = parseDateInZone('03/01/2026 00:30', 'mdy', 'America/New_York')
    expect(newYork?.toISOString()).toBe('2026-03-01T05:30:00.000Z')
  })

  it('handles a US daylight-saving transition without shifting the day', () => {
    // 8 March 2026 is the US spring-forward date; a 23:30 sale that evening is
    // still 8 March locally and must not roll into the 9th.
    const evening = parseDateInZone('03/08/2026 23:30', 'mdy', 'America/New_York')
    expect(evening?.toISOString()).toBe('2026-03-09T03:30:00.000Z')
  })

  it('returns null for a value it cannot read', () => {
    expect(parseDateInZone('not a date', 'dmy', 'UTC')).toBeNull()
    expect(parseDateInZone('', 'dmy', 'UTC')).toBeNull()
  })
})

describe('parseNumber grouping ambiguity', () => {
  it.each([
    ['1,299', 1299],
    ['1,23,456', 123456],
    ['123,45', 123.45],
    ['1.234.567', 1234567],
    ['1.234', 1.234],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected)
  })
})
