/**
 * ONBOARD-02 — server-side CSV parsing primitives.
 *
 * This runs on the server and never trusts client-parsed rows, because what it
 * produces is written to the sale ledger. It also has to survive what real POS
 * exports actually contain rather than what the CSV spec says they should:
 * BOM headers, semicolon delimiters, Windows-1252 bytes, quoted commas,
 * `1,23,456.78` Indian digit grouping, several mutually incompatible date
 * formats, and a tail of blank rows from a spreadsheet round-trip.
 */

/** A 5 MB / 50k-row cap. Past this, an import is a migration project, not an upload. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_ROWS = 50_000

export type SourceEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252' | 'excel-xls' | 'excel-xlsx'

export type ParsedCsv = {
  columns: string[]
  rows: Record<string, string>[]
  delimiter: string
  encoding: SourceEncoding
  /** Rows that were entirely empty and dropped — reported, never silently eaten. */
  blankRowsSkipped: number
  /** Rows whose field count did not match the header. Padded, and counted here. */
  raggedRows: number
}

export class CsvParseError extends Error {}

/**
 * Decode raw upload bytes. Tries UTF-8 strictly first; a file that is not valid
 * UTF-8 is almost always a Windows-1252 export from an older Windows POS, and
 * decoding it as UTF-8 with replacement characters would corrupt every accented
 * product name rather than fail loudly.
 */
export function decodeCsvBuffer(buffer: Buffer): { text: string; encoding: SourceEncoding } {
  if (buffer.length > MAX_FILE_BYTES) {
    throw new CsvParseError(
      `File is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB — split it and import in parts.`,
    )
  }

  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const body = hasBom ? buffer.subarray(3) : buffer

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return { text, encoding: hasBom ? 'utf-8-bom' : 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' }
  }
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const

/**
 * Pick the delimiter by counting candidates in the header line while ignoring
 * anything inside quotes — counting blind would choose `,` for a semicolon file
 * whose first column is `"Smith, John"`.
 */
export function detectDelimiter(headerLine: string): string {
  let best = ','
  let bestCount = 0

  for (const candidate of CANDIDATE_DELIMITERS) {
    let count = 0
    let inQuotes = false
    for (let i = 0; i < headerLine.length; i += 1) {
      const char = headerLine[i]
      if (char === '"') {
        if (inQuotes && headerLine[i + 1] === '"') i += 1
        else inQuotes = !inQuotes
      } else if (char === candidate && !inQuotes) {
        count += 1
      }
    }
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }

  return best
}

/** RFC 4180 field splitting, tolerant of CRLF and of a stray quote mid-field. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  const endField = () => {
    record.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    records.push(record)
    record = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true
    } else if (char === delimiter) {
      endField()
    } else if (char === '\n') {
      endRecord()
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1
      endRecord()
    } else {
      field += char
    }
  }

  if (field.length > 0 || record.length > 0) endRecord()
  return records
}

function isBlankRecord(record: string[]): boolean {
  return record.every((value) => value.trim() === '')
}

/**
 * Name a header cell that arrived empty. Discarding the column instead would
 * silently drop whatever data sits under it, which is exactly the failure this
 * import is supposed to make impossible.
 */
function headerName(raw: string, index: number, taken: Set<string>): string {
  let name = raw.trim().replace(/^﻿/, '')
  if (name === '') name = `Column ${index + 1}`
  let unique = name
  let suffix = 2
  while (taken.has(unique)) {
    unique = `${name} (${suffix})`
    suffix += 1
  }
  taken.add(unique)
  return unique
}

/** Decode then parse — the entry point a route should use for an upload. */
export function parseCsvUpload(buffer: Buffer, options: { delimiter?: string; maxRows?: number } = {}): ParsedCsv {
  const { text, encoding } = decodeCsvBuffer(buffer)
  return { ...parseCsv(text, options), encoding }
}

export function parseCsv(text: string, options: { delimiter?: string; maxRows?: number; encoding?: SourceEncoding } = {}): ParsedCsv {
  const maxRows = options.maxRows ?? MAX_ROWS
  const firstLineBreak = text.search(/\r?\n/)
  const headerLine = firstLineBreak === -1 ? text : text.slice(0, firstLineBreak)
  const delimiter = options.delimiter ?? detectDelimiter(headerLine)

  const records = splitRecords(text, delimiter)
  const headerRecord = records.find((record) => !isBlankRecord(record))
  if (!headerRecord) {
    throw new CsvParseError('That file has no header row we could read.')
  }

  const taken = new Set<string>()
  const columns = headerRecord.map((raw, index) => headerName(raw, index, taken))

  const rows: Record<string, string>[] = []
  let blankRowsSkipped = 0
  let raggedRows = 0

  for (const record of records.slice(records.indexOf(headerRecord) + 1)) {
    if (isBlankRecord(record)) {
      blankRowsSkipped += 1
      continue
    }
    if (record.length !== columns.length) raggedRows += 1
    if (rows.length >= maxRows) {
      throw new CsvParseError(
        `That file has more than ${maxRows.toLocaleString()} rows. Split it and import in parts.`,
      )
    }

    const row: Record<string, string> = {}
    columns.forEach((column, index) => {
      row[column] = (record[index] ?? '').trim()
    })
    rows.push(row)
  }

  return { columns, rows, delimiter, encoding: options.encoding ?? 'utf-8', blankRowsSkipped, raggedRows }
}

/**
 * Parse a number out of whatever the source system formatted it as.
 *
 * Handles Indian grouping (`1,23,456.78`), Western grouping (`123,456.78`),
 * European convention (`123.456,78`), currency symbols, and parenthesised
 * negatives. Returns null rather than NaN or 0 — a value we cannot read must be
 * reported as unreadable, never silently treated as zero on a money column.
 */
export function parseNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith('-')
  let body = trimmed.replace(/^[-(]|\)$/g, '')
  body = body.replace(/[^\d.,]/g, '')
  if (body === '') return null

  const lastComma = body.lastIndexOf(',')
  const lastDot = body.lastIndexOf('.')

  let normalised: string
  if (lastComma === -1 && lastDot === -1) {
    normalised = body
  } else if (lastComma > -1 && lastDot === -1) {
    // Commas only, so the last group decides. Three digits after the final
    // comma is a thousands group in every convention that uses one — that is
    // what makes `1,299` and `1,23,456` both read as whole rupees, while
    // `123,45` is still recognised as a European decimal.
    normalised = body.slice(lastComma + 1).length === 3 ? body.replace(/,/g, '') : body.replace(',', '.')
  } else if (lastDot > -1 && lastComma === -1) {
    // Dots only. More than one can only be grouping; a single dot is the
    // decimal separator, which is the overwhelmingly more common reading.
    normalised = body.split('.').length > 2 ? body.replace(/\./g, '') : body
  } else if (lastComma > lastDot) {
    // European: the comma is the decimal separator (`123.456,78`).
    normalised = body.replace(/\./g, '').replace(',', '.')
  } else {
    // Dot is the decimal separator; every comma is grouping, whatever its
    // spacing — this is what makes `1,23,456.78` parse the same as `123,456.78`.
    normalised = body.replace(/,/g, '')
  }

  const value = Number(normalised)
  if (!Number.isFinite(value)) return null
  return negative ? -value : value
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
}

export type DateOrder = 'dmy' | 'mdy' | 'ymd'

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function splitDateValue(raw: string): { numbers: number[]; monthName: number | null; time: [number, number, number] } | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const timeMatch = trimmed.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i)
  let hour = 0
  let minute = 0
  let second = 0
  if (timeMatch) {
    hour = Number(timeMatch[1])
    minute = Number(timeMatch[2])
    second = timeMatch[3] ? Number(timeMatch[3]) : 0
    const meridiem = timeMatch[4]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  }

  const datePart = timeMatch ? trimmed.slice(0, timeMatch.index).trim() : trimmed
  const nameMatch = datePart.match(/[a-z]{3,}/i)
  const monthName = nameMatch ? (MONTHS[nameMatch[0].toLowerCase().slice(0, 4)] ?? MONTHS[nameMatch[0].toLowerCase().slice(0, 3)] ?? null) : null

  const numbers = (datePart.match(/\d+/g) ?? []).map(Number)
  if (numbers.length < 2) return null

  return { numbers, monthName: monthName ?? null, time: [hour, minute, second] }
}

/**
 * Decide day-first vs month-first for a whole column at once.
 *
 * A single `03/04/2026` is genuinely ambiguous, so guessing per-value would
 * scatter a column across two calendars. Scanning every value in the column
 * usually resolves it: one `13/05/2026` proves day-first for all of them.
 */
export function detectDateOrder(values: string[]): DateOrder {
  let dayFirstEvidence = 0
  let monthFirstEvidence = 0
  let isoEvidence = 0

  for (const value of values) {
    const parts = splitDateValue(value)
    if (!parts || parts.numbers.length < 2) continue
    const [a, b] = parts.numbers

    if (String(parts.numbers[0]).length === 4) {
      isoEvidence += 1
      continue
    }
    if (parts.monthName !== null) continue
    if (a > 12 && b <= 12) dayFirstEvidence += 1
    else if (b > 12 && a <= 12) monthFirstEvidence += 1
  }

  if (isoEvidence > dayFirstEvidence && isoEvidence > monthFirstEvidence) return 'ymd'
  if (monthFirstEvidence > dayFirstEvidence) return 'mdy'
  // Ties fall to day-first: it is the convention in every region this product
  // ships to, and US exports overwhelmingly carry an unambiguous 4-digit-year
  // ISO or a month name.
  return 'dmy'
}

function toParts(raw: string, order: DateOrder): DateParts | null {
  const split = splitDateValue(raw)
  if (!split) return null
  const { numbers, monthName, time } = split

  let year: number
  let month: number
  let day: number

  if (monthName !== null && numbers.length >= 2) {
    month = monthName
    const [a, b] = numbers
    if (String(a).length === 4) {
      year = a
      day = b
    } else if (String(b).length === 4) {
      day = a
      year = b
    } else {
      day = a
      year = b
    }
  } else if (numbers.length < 3) {
    return null
  } else if (String(numbers[0]).length === 4 || order === 'ymd') {
    ;[year, month, day] = [numbers[0], numbers[1] - 1, numbers[2]]
  } else if (order === 'mdy') {
    ;[month, day, year] = [numbers[0] - 1, numbers[1], numbers[2]]
  } else {
    ;[day, month, year] = [numbers[0], numbers[1] - 1, numbers[2]]
  }

  if (year < 100) year += year < 70 ? 2000 : 1900
  if (month < 0 || month > 11 || day < 1 || day > 31) return null

  return { year, month, day, hour: time[0], minute: time[1], second: time[2] }
}

/**
 * Resolve a source date to a UTC instant, interpreting the wall-clock value in
 * the tenant's own timezone.
 *
 * This matters more than it looks: `daily_sales_rollup` buckets by business day
 * using `tenants.timezone`, so an imported `01/03/2026 00:30` that we stored as
 * 00:30 UTC would book to the previous business day in Asia/Kolkata and land
 * the row on the wrong date for Phase 6's forecast series.
 */
export function parseDateInZone(raw: string, order: DateOrder, timeZone: string): Date | null {
  const parts = toParts(raw, order)
  if (!parts) return null

  const naiveUtc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)
  if (Number.isNaN(naiveUtc)) return null

  // Offset is resolved at the target instant, so DST transitions are handled by
  // the runtime's tz database rather than a hardcoded offset.
  const offset = zoneOffsetMs(new Date(naiveUtc), timeZone)
  const candidate = new Date(naiveUtc - offset)
  const refined = new Date(naiveUtc - zoneOffsetMs(candidate, timeZone))
  return Number.isNaN(refined.getTime()) ? null : refined
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>

  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second)
  return asUtc - instant.getTime()
}
