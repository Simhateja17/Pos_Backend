import { Router } from 'express'
import { forTenantTransaction } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  ReportQuerySchema,
  type ReportKind,
  type ReportTable,
} from '../contracts/schemas/reports'

const router = Router()

/**
 * REPORT-01 — sales, stock and staff-exception reports over a chosen range.
 *
 * Two things worth knowing before reading the SQL:
 *
 * - Ranges are BUSINESS dates in the tenant's timezone, matching how
 *   `daily_sales_rollup` buckets (migration 0022). A report that silently used
 *   UTC would disagree with the dashboard for every sale near midnight.
 * - Imported history is included by default but is always separable via
 *   `sales.source`, and each report says how much of its total came from
 *   imported rows rather than from money rung up here.
 */

const CATALOG = [
  { kind: 'sales-by-day', title: 'Sales by day', description: 'Revenue, bills and units for each business day.', group: 'sales' },
  { kind: 'sales-by-product', title: 'Sales by product', description: 'Units and revenue per product, best sellers first.', group: 'sales' },
  { kind: 'sales-by-category', title: 'Sales by category', description: 'Where revenue is concentrated across the catalog.', group: 'sales' },
  { kind: 'sales-by-staff', title: 'Sales by staff', description: 'Bills rung up and revenue taken per staff member.', group: 'sales' },
  { kind: 'stock-valuation', title: 'Stock valuation', description: 'What is on the shelves and what it cost you.', group: 'stock' },
  { kind: 'stock-movements', title: 'Stock movement history', description: 'Every receipt, sale, return and adjustment in the range.', group: 'stock' },
  { kind: 'staff-exceptions', title: 'Staff exception report', description: 'Refunds and discounts by staff member — the loss-prevention view.', group: 'staff' },
] as const

function defaultRange(): { from: string; to: string } {
  const today = new Date()
  const from = new Date(today)
  from.setUTCDate(from.getUTCDate() - 29)
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) }
}

function money(value: unknown): number {
  return Number(value ?? 0)
}

router.get('/catalog', async (_req, res) => {
  return res.json({ reports: CATALOG.map((entry) => ({ ...entry })) })
})

router.get('/', requireRole('manager'), async (req, res) => {
  const parsed = ReportQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'That report or date range is not one we can run.' })
  }

  const fallback = defaultRange()
  const from = parsed.data.from ?? fallback.from
  const to = parsed.data.to ?? fallback.to
  if (from > to) {
    return res.status(400).json({ error: 'The start date is after the end date.' })
  }

  const includeImported = parsed.data.includeImported !== 'false'
  const tenantId = req.user!.tenantId

  const table = await forTenantTransaction(tenantId, async (tx) => {
    const tenant = await tx.tenants.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = tenant?.timezone ?? 'UTC'
    return buildReport(tx, {
      kind: parsed.data.kind,
      tenantId,
      storeId: req.storeContext?.activeStoreId ?? null,
      zone,
      from,
      to,
      includeImported,
    })
  })

  return res.json(table)
})

type BuildArgs = {
  kind: ReportKind
  tenantId: string
  /**
   * Phase 8: the shop this report covers, or null for an owner's business-wide
   * report. Reports are raw SQL, so they do not get store scoping for free from
   * the Prisma helpers — each query has to filter explicitly.
   */
  storeId: string | null
  zone: string
  from: string
  to: string
  includeImported: boolean
}

export async function buildReport(tx: any, args: BuildArgs): Promise<ReportTable> {
  const meta = CATALOG.find((entry) => entry.kind === args.kind)!
  const base: Omit<ReportTable, 'columns' | 'rows' | 'totals' | 'unavailable'> = {
    id: args.kind,
    title: meta.title,
    description: meta.description,
    range: { from: args.from, to: args.to },
    generatedAt: new Date().toISOString(),
  }

  // Business-day window expressed as an instant range, so the index on
  // sales(created_at) is usable rather than being defeated by a per-row cast.
  const sourceFilter = args.includeImported ? '' : `and s.source = 'pos'`
  const window = `
    s.created_at >= (($1::date)::timestamp at time zone $3)
    and s.created_at < ((($2::date) + 1)::timestamp at time zone $3)
  `

  switch (args.kind) {
    case 'sales-by-day': {
      const rows = await tx.$queryRawUnsafe(
        `select (s.created_at at time zone $3)::date::text as day,
                count(distinct s.id)::int as bills,
                coalesce(sum(l.quantity), 0)::int as units,
                coalesce(sum(l.line_total), 0) as revenue,
                coalesce(sum(s.tax_amount), 0) as tax,
                count(distinct s.id) filter (where s.source = 'import')::int as imported_bills
         from sales s
         join sale_line_items l on l.sale_id = s.id
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter}
         group by 1 order by 1`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
      )

      return {
        ...base,
        columns: [
          { key: 'day', label: 'Business day', align: 'left', money: false },
          { key: 'bills', label: 'Bills', align: 'right', money: false },
          { key: 'units', label: 'Units', align: 'right', money: false },
          { key: 'revenue', label: 'Revenue', align: 'right', money: true },
          { key: 'tax', label: 'Tax', align: 'right', money: true },
          { key: 'imported_bills', label: 'Of which imported', align: 'right', money: false },
        ],
        rows: rows.map((row: any) => ({ ...row, revenue: money(row.revenue), tax: money(row.tax) })),
        totals: {
          day: 'Total',
          bills: rows.reduce((sum: number, row: any) => sum + row.bills, 0),
          units: rows.reduce((sum: number, row: any) => sum + row.units, 0),
          revenue: rows.reduce((sum: number, row: any) => sum + money(row.revenue), 0),
          tax: rows.reduce((sum: number, row: any) => sum + money(row.tax), 0),
          imported_bills: rows.reduce((sum: number, row: any) => sum + row.imported_bills, 0),
        },
        unavailable: [],
      }
    }

    case 'sales-by-product':
    case 'sales-by-category': {
      const byCategory = args.kind === 'sales-by-category'
      // `products.category` was removed by migration 0032. Categories are
      // tenant-owned rows now, so resolve the display name through the
      // category relation and keep products without a category visible.
      const label = byCategory ? `coalesce(c.name, 'Uncategorised')` : 'p.name'
      const extra = byCategory ? '' : ', v.sku'
      const rows = await tx.$queryRawUnsafe(
        `select ${label} as label${extra},
                coalesce(sum(l.quantity), 0)::int as units,
                coalesce(sum(l.line_total), 0) as revenue,
                coalesce(sum(l.discount_amount), 0) as discount
         from sale_line_items l
         join sales s on s.id = l.sale_id
         join variants v on v.id = l.variant_id
         join products p on p.id = v.product_id
         left join categories c on c.id = p.category_id and c.tenant_id = p.tenant_id
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter}
         group by 1${byCategory ? '' : ', v.sku'} order by 3 desc limit 500`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
      )

      return {
        ...base,
        columns: [
          { key: 'label', label: byCategory ? 'Category' : 'Product', align: 'left', money: false },
          ...(byCategory ? [] : [{ key: 'sku', label: 'SKU', align: 'left' as const, money: false }]),
          { key: 'units', label: 'Units', align: 'right', money: false },
          { key: 'revenue', label: 'Revenue', align: 'right', money: true },
          { key: 'discount', label: 'Discount given', align: 'right', money: true },
        ],
        rows: rows.map((row: any) => ({
          ...row,
          revenue: money(row.revenue),
          discount: money(row.discount),
        })),
        totals: {
          label: 'Total',
          units: rows.reduce((sum: number, row: any) => sum + row.units, 0),
          revenue: rows.reduce((sum: number, row: any) => sum + money(row.revenue), 0),
          discount: rows.reduce((sum: number, row: any) => sum + money(row.discount), 0),
        },
        unavailable:
          rows.length === 500
            ? [{ what: 'Rows beyond the first 500', reason: 'Narrow the date range to see the rest.' }]
            : [],
      }
    }

    case 'sales-by-staff': {
      const rows = await tx.$queryRawUnsafe(
        `select coalesce(st.name, 'Unattributed') as staff,
                count(distinct s.id)::int as bills,
                coalesce(sum(l.line_total), 0) as revenue,
                coalesce(sum(l.discount_amount), 0) as discount
         from sales s
         join sale_line_items l on l.sale_id = s.id
         left join staff_members st on st.id = s.created_by
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter}
         group by 1 order by 3 desc`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
      )

      const unattributed = rows.some((row: any) => row.staff === 'Unattributed')
      return {
        ...base,
        columns: [
          { key: 'staff', label: 'Staff member', align: 'left', money: false },
          { key: 'bills', label: 'Bills', align: 'right', money: false },
          { key: 'revenue', label: 'Revenue', align: 'right', money: true },
          { key: 'discount', label: 'Discount given', align: 'right', money: true },
        ],
        rows: rows.map((row: any) => ({ ...row, revenue: money(row.revenue), discount: money(row.discount) })),
        totals: {
          staff: 'Total',
          bills: rows.reduce((sum: number, row: any) => sum + row.bills, 0),
          revenue: rows.reduce((sum: number, row: any) => sum + money(row.revenue), 0),
          discount: rows.reduce((sum: number, row: any) => sum + money(row.discount), 0),
        },
        unavailable: unattributed
          ? [
              {
                what: 'The "Unattributed" row',
                reason: 'These bills carry no staff member — imported history and sales rung up before staff PINs were set up.',
              },
            ]
          : [],
      }
    }

    case 'stock-valuation': {
      // Point-in-time: current stock, not a range. Said so in the description
      // rather than pretending the date filter applies.
      // variant_stock_levels holds one row per (variant, STORE) since 0043.
      // A plain `left join ... on sl.variant_id = v.id` therefore emits one row
      // PER SHOP for every variant, so a shirt stocked in two shops appeared
      // twice and the report's totals counted it twice. Aggregate before
      // joining, filtered to the report's shop ($2 null = whole business).
      const rows = await tx.$queryRawUnsafe(
        `select p.name as product, v.sku, coalesce(sl.quantity, 0)::int as on_hand,
                v.price as unit_price, v.moving_average_cost as unit_cost,
                (coalesce(sl.quantity, 0) * v.price) as retail_value,
                case when v.moving_average_cost is null then null
                     else coalesce(sl.quantity, 0) * v.moving_average_cost end as cost_value
         from variants v
         join products p on p.id = v.product_id
         left join (
           select variant_id, sum(quantity) as quantity
           from variant_stock_levels
           where ($2::uuid is null or store_id = $2::uuid)
           group by variant_id
         ) sl on sl.variant_id = v.id
         where v.tenant_id = $1::uuid
         order by 7 desc nulls last, 6 desc
         limit 1000`,
        args.tenantId,
        args.storeId,
      )

      const uncosted = rows.filter((row: any) => row.unit_cost === null).length
      return {
        ...base,
        description: 'What is on the shelves right now and what it cost you. This is a point-in-time figure — the date range does not apply.',
        columns: [
          { key: 'product', label: 'Product', align: 'left', money: false },
          { key: 'sku', label: 'SKU', align: 'left', money: false },
          { key: 'on_hand', label: 'On hand', align: 'right', money: false },
          { key: 'unit_cost', label: 'Unit cost', align: 'right', money: true },
          { key: 'cost_value', label: 'Value at cost', align: 'right', money: true },
          { key: 'unit_price', label: 'Unit price', align: 'right', money: true },
          { key: 'retail_value', label: 'Value at retail', align: 'right', money: true },
        ],
        rows: rows.map((row: any) => ({
          ...row,
          unit_price: money(row.unit_price),
          unit_cost: row.unit_cost === null ? null : money(row.unit_cost),
          retail_value: money(row.retail_value),
          cost_value: row.cost_value === null ? null : money(row.cost_value),
        })),
        totals: {
          product: 'Total',
          on_hand: rows.reduce((sum: number, row: any) => sum + row.on_hand, 0),
          cost_value: rows.reduce((sum: number, row: any) => sum + money(row.cost_value), 0),
          retail_value: rows.reduce((sum: number, row: any) => sum + money(row.retail_value), 0),
        },
        unavailable: uncosted
          ? [
              {
                what: `Cost value for ${uncosted} variant${uncosted === 1 ? '' : 's'}`,
                reason: 'No cost basis has been recorded yet. Receive them on a purchase order, or import a cost column, and the value appears.',
              },
            ]
          : [],
      }
    }

    case 'stock-movements': {
      const rows = await tx.$queryRawUnsafe(
        `select (m.created_at at time zone $3)::date::text as day,
                p.name as product, v.sku, m.movement_type::text as movement,
                m.quantity_delta::int as change,
                coalesce(m.reason_code::text, m.reason_note, '') as reason,
                coalesce(st.name, '') as staff
         from stock_movements m
         join variants v on v.id = m.variant_id
         join products p on p.id = v.product_id
         left join staff_members st on st.id = m.created_by
         where m.tenant_id = $4::uuid
           and m.created_at >= (($1::date)::timestamp at time zone $3)
           and m.created_at < ((($2::date) + 1)::timestamp at time zone $3)
         order by m.created_at desc limit 1000`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
      )

      return {
        ...base,
        columns: [
          { key: 'day', label: 'Date', align: 'left', money: false },
          { key: 'product', label: 'Product', align: 'left', money: false },
          { key: 'sku', label: 'SKU', align: 'left', money: false },
          { key: 'movement', label: 'Movement', align: 'left', money: false },
          { key: 'change', label: 'Change', align: 'right', money: false },
          { key: 'reason', label: 'Reason', align: 'left', money: false },
          { key: 'staff', label: 'Staff', align: 'left', money: false },
        ],
        rows,
        totals: null,
        unavailable:
          rows.length === 1000
            ? [{ what: 'Movements beyond the most recent 1,000', reason: 'Narrow the date range to see the rest.' }]
            : [],
      }
    }

    case 'staff-exceptions': {
      // Refunds are attributed to whoever processed the refund payment, not to
      // whoever rang the original sale — that is the person the report is about.
      const refunds = await tx.$queryRawUnsafe(
        `select coalesce(st.name, 'Unattributed') as staff,
                count(*)::int as refund_count,
                coalesce(sum(pay.amount), 0) as refund_value
         from payments pay
         left join staff_members st on st.id = pay.created_by
         where pay.tenant_id = $4::uuid and pay.direction = 'refund'
           and pay.created_at >= (($1::date)::timestamp at time zone $3)
           and pay.created_at < ((($2::date) + 1)::timestamp at time zone $3)
         group by 1`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
      )

      const discounts = await tx.$queryRawUnsafe(
        `select coalesce(st.name, 'Unattributed') as staff,
                count(distinct s.id) filter (where l.discount_amount > 0)::int as discounted_bills,
                coalesce(sum(l.discount_amount), 0) as discount_value,
                count(distinct s.id)::int as bills,
                coalesce(sum(l.line_total), 0) as revenue
         from sales s
         join sale_line_items l on l.sale_id = s.id
         left join staff_members st on st.id = s.created_by
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter}
         group by 1`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
      )

      const byStaff = new Map<string, any>()
      for (const row of discounts) {
        byStaff.set(row.staff, {
          staff: row.staff,
          bills: row.bills,
          revenue: money(row.revenue),
          discounted_bills: row.discounted_bills,
          discount_value: money(row.discount_value),
          discount_rate: money(row.revenue) > 0 ? Number(((money(row.discount_value) / money(row.revenue)) * 100).toFixed(1)) : 0,
          refund_count: 0,
          refund_value: 0,
        })
      }
      for (const row of refunds) {
        const existing = byStaff.get(row.staff) ?? {
          staff: row.staff,
          bills: 0,
          revenue: 0,
          discounted_bills: 0,
          discount_value: 0,
          discount_rate: 0,
          refund_count: 0,
          refund_value: 0,
        }
        existing.refund_count = row.refund_count
        existing.refund_value = money(row.refund_value)
        byStaff.set(row.staff, existing)
      }

      const rows = [...byStaff.values()].sort(
        (a, b) => b.refund_value + b.discount_value - (a.refund_value + a.discount_value),
      )

      return {
        ...base,
        columns: [
          { key: 'staff', label: 'Staff member', align: 'left', money: false },
          { key: 'bills', label: 'Bills', align: 'right', money: false },
          { key: 'revenue', label: 'Revenue', align: 'right', money: true },
          { key: 'discounted_bills', label: 'Bills with a discount', align: 'right', money: false },
          { key: 'discount_value', label: 'Discount given', align: 'right', money: true },
          { key: 'discount_rate', label: 'Discount % of revenue', align: 'right', money: false },
          { key: 'refund_count', label: 'Refunds', align: 'right', money: false },
          { key: 'refund_value', label: 'Refund value', align: 'right', money: true },
        ],
        rows,
        totals: {
          staff: 'Total',
          bills: rows.reduce((sum, row) => sum + row.bills, 0),
          revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
          discounted_bills: rows.reduce((sum, row) => sum + row.discounted_bills, 0),
          discount_value: rows.reduce((sum, row) => sum + row.discount_value, 0),
          refund_count: rows.reduce((sum, row) => sum + row.refund_count, 0),
          refund_value: rows.reduce((sum, row) => sum + row.refund_value, 0),
        },
        // Voids are the third leg of the classic exception report and are
        // genuinely absent: `sales.status` is CHECK-constrained to 'completed',
        // so a void is not a thing this system records. Showing a zero column
        // would read as "no voids happened", which is a different claim.
        unavailable: [
          {
            what: 'Voided bills',
            reason: 'Bills cannot currently be voided in this POS — a correction is made as a refund, which is counted above.',
          },
        ],
      }
    }
  }
}

export default router
