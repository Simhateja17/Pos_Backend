import { extname } from 'node:path'
import * as XLSX from 'xlsx'
import {
  CsvParseError,
  MAX_ROWS,
  decodeCsvBuffer,
  parseCsv,
  parseCsvUpload,
  type ParsedCsv,
  type SourceEncoding,
} from './csv-parse'

const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx'])

export type ImportFileFormat = 'csv' | 'xls' | 'xlsx'

export type ParsedImportFile = ParsedCsv & {
  /** Normalized text kept in the import batch and re-parsed at commit time. */
  sourceText: string
  format: ImportFileFormat
}

function formatForFileName(fileName: string): ImportFileFormat {
  const extension = extname(fileName).toLowerCase()
  if (extension === '.xls' || extension === '.xlsx') return extension.slice(1) as 'xls' | 'xlsx'
  return 'csv'
}

function parseSpreadsheetUpload(buffer: Buffer, format: 'xls' | 'xlsx'): ParsedImportFile {
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: false,
      cellText: true,
      // A workbook can contain many unrelated tabs. The import contract is one
      // table per file, so use the first non-empty worksheet rather than
      // accidentally concatenating tabs with different schemas.
    })
  } catch {
    throw new CsvParseError(
      `That ${format.toUpperCase()} workbook could not be opened. Save it as a standard Excel file and retry.`,
    )
  }

  let firstReadableSheet: ParsedImportFile | null = null

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet || !sheet['!ref']) continue

    const range = XLSX.utils.decode_range(sheet['!ref'])
    const rowCount = range.e.r - range.s.r
    if (rowCount > MAX_ROWS) {
      throw new CsvParseError(
        `That workbook has more than ${MAX_ROWS.toLocaleString()} rows in the first usable sheet. Split it and import in parts.`,
      )
    }

    const sourceText = XLSX.utils.sheet_to_csv(sheet, { blankrows: true })
    if (sourceText.trim() === '') continue

    const encoding: SourceEncoding = format === 'xls' ? 'excel-xls' : 'excel-xlsx'
    const parsed = parseCsv(sourceText, { encoding })
    const normalized = { ...parsed, sourceText, format }
    firstReadableSheet ??= normalized
    if (parsed.rows.length > 0) return normalized
  }

  if (firstReadableSheet) return firstReadableSheet
  throw new CsvParseError(`That ${format.toUpperCase()} workbook has no non-empty worksheet we can import.`)
}

/**
 * Parse the uploaded file according to its extension, while keeping one
 * normalized row representation for preview, mapping, and commit.
 *
 * CSV parsing remains the default for backwards compatibility. Excel files
 * are converted from their first non-empty worksheet to CSV text on the
 * server; the browser never supplies rows that can reach the ledger.
 */
export function parseImportFile(buffer: Buffer, fileName: string): ParsedImportFile {
  const format = formatForFileName(fileName)
  if (EXCEL_EXTENSIONS.has(extname(fileName).toLowerCase())) {
    return parseSpreadsheetUpload(buffer, format as 'xls' | 'xlsx')
  }

  const { text } = decodeCsvBuffer(buffer)
  return { ...parseCsvUpload(buffer), sourceText: text, format: 'csv' }
}
