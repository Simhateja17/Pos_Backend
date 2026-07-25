import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

/**
 * REPORT-01 — reports share one table shape.
 *
 * Every report is columns + rows + totals, which is what lets a single CSV
 * exporter and a single screen serve all of them. Report-specific meaning
 * lives in the column labels, not in bespoke response types.
 */
export const ReportColumnSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    align: z.enum(['left', 'right']).default('left'),
    /** Rendered as currency by the client. */
    money: z.boolean().default(false),
  })
  .openapi('ReportColumn')

export const ReportTableSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    /** What the figures mean and where they come from — shown above the table. */
    description: z.string(),
    columns: z.array(ReportColumnSchema),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    totals: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
    range: z.object({ from: z.string(), to: z.string() }),
    generatedAt: z.string().datetime(),
    /**
     * Set when part of this report has no data behind it in V1. Stated plainly
     * rather than shown as a zero, which would read as "none happened".
     */
    unavailable: z.array(z.object({ what: z.string(), reason: z.string() })),
  })
  .openapi('ReportTable')

export const ReportKindSchema = z
  .enum([
    'sales-by-day',
    'sales-by-product',
    'sales-by-category',
    'sales-by-staff',
    'stock-valuation',
    'stock-movements',
    'staff-exceptions',
  ])
  .openapi('ReportKind')

export const ReportQuerySchema = z
  .object({
    kind: ReportKindSchema,
    /** Business dates, inclusive, in the tenant's timezone. Defaults to the last 30 days. */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Whether imported history counts. Defaults to including it. */
    includeImported: z.enum(['true', 'false']).optional(),
  })
  .openapi('ReportQuery')

export const ReportCatalogSchema = z
  .object({
    reports: z.array(
      z.object({
        kind: ReportKindSchema,
        title: z.string(),
        description: z.string(),
        group: z.enum(['sales', 'stock', 'staff']),
      }),
    ),
  })
  .openapi('ReportCatalog')

export type ReportKind = z.infer<typeof ReportKindSchema>
export type ReportTable = z.infer<typeof ReportTableSchema>
