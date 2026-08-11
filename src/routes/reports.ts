import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { forTenantTransaction } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  ReportQuerySchema,
  type ReportKind,
  type ReportTable,
} from '../contracts/schemas/reports'

const router = Router()

/**
 * REPORT-01 — fixed sales, payment, purchasing, stock and staff-exception
 * reports over a chosen range.
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
  { kind: 'payments-by-method', title: 'Payments by method', description: 'Collected and refunded tenders by persisted payment method.', group: 'payments' },
  { kind: 'refunds-by-method', title: 'Refunds by method', description: 'Refund count and value by the tender returned to the customer.', group: 'payments' },
  { kind: 'shift-tender-reconciliation', title: 'Shift tender reconciliation', description: 'Opening cash, tender movement and counted drawer cash for every shift.', group: 'payments' },
  { kind: 'purchases-by-supplier', title: 'Purchases by supplier', description: 'Purchase orders, receipt value and outstanding ordered quantities by supplier.', group: 'purchases' },
  { kind: 'goods-received-by-day', title: 'Goods received by day', description: 'Actual receipt events and receipt cost, separate from ordered value.', group: 'purchases' },
  { kind: 'purchase-cost-by-product', title: 'Purchase cost by product', description: 'Receipt quantities, weighted receipt cost and current moving-average cost.', group: 'purchases' },
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

const ZERO = new Prisma.Decimal(0)

/**
 * Keep report arithmetic in Decimal until the final JSON boundary. PostgreSQL
 * performs the grouped aggregates; these helpers prevent the totals row from
 * reintroducing binary floating-point arithmetic in Node.
 */
function decimal(value: unknown): Prisma.Decimal {
  return new Prisma.Decimal(String(value ?? 0))
}

function sumMoney(rows: readonly any[], key: string): number {
  return rows.reduce((total, row) => total.plus(decimal(row[key])), ZERO).toNumber()
}

function sumCount(rows: readonly any[], key: string): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
}

function dateWindow(column: string, zonePlaceholder = '$3'): string {
  return `${column} >= (($1::date)::timestamp at time zone ${zonePlaceholder})
          and ${column} < ((($2::date) + 1)::timestamp at time zone ${zonePlaceholder})`
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
  const salesStoreFilter = args.storeId ? `and s.store_id = $5::uuid` : ''
  const movementStoreFilter = args.storeId ? `and m.store_id = $5::uuid` : ''
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
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter} ${salesStoreFilter}
         group by 1 order by 1`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        ...(args.storeId ? [args.storeId] : []),
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
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter} ${salesStoreFilter}
         group by 1${byCategory ? '' : ', v.sku'} order by 3 desc limit 500`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        ...(args.storeId ? [args.storeId] : []),
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
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter} ${salesStoreFilter}
         group by 1 order by 3 desc`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        ...(args.storeId ? [args.storeId] : []),
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

    case 'payments-by-method':
    case 'refunds-by-method': {
      const refundsOnly = args.kind === 'refunds-by-method'
      const sourceFilter = args.includeImported ? '' : `and s.source = 'pos'`
      const rows = await tx.$queryRawUnsafe(
        `select pay.method::text as method,
                count(*) filter (where pay.direction = 'payment')::int as collected_count,
                coalesce(sum(pay.amount) filter (where pay.direction = 'payment'), 0) as collected_amount,
                count(*) filter (where pay.direction = 'refund')::int as refund_count,
                coalesce(sum(abs(pay.amount)) filter (where pay.direction = 'refund'), 0) as refund_amount,
                coalesce(sum(case
                  when pay.direction = 'payment' then pay.amount
                  when pay.direction = 'refund' then -abs(pay.amount)
                  else 0
                end), 0) as net_amount
         from payments pay
         join sales s on s.id = pay.sale_id and s.tenant_id = $4::uuid
         where pay.tenant_id = $4::uuid
           and ${dateWindow('pay.created_at')}
           and ($5::uuid is null or s.store_id = $5::uuid)
           ${sourceFilter}
           ${refundsOnly ? `and pay.direction = 'refund'` : ''}
         group by pay.method::text
         order by pay.method::text`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        args.storeId,
      )

      if (refundsOnly) {
        return {
          ...base,
          columns: [
            { key: 'method', label: 'Payment method', align: 'left', money: false },
            { key: 'refund_count', label: 'Refunds', align: 'right', money: false },
            { key: 'refund_amount', label: 'Refunded amount', align: 'right', money: true },
          ],
          rows: rows.map((row: any) => ({
            method: row.method,
            refund_count: row.refund_count,
            refund_amount: money(row.refund_amount),
          })),
          totals: {
            method: 'Total',
            refund_count: sumCount(rows, 'refund_count'),
            refund_amount: sumMoney(rows, 'refund_amount'),
          },
          unavailable: [],
        }
      }

      return {
        ...base,
        columns: [
          { key: 'method', label: 'Payment method', align: 'left', money: false },
          { key: 'collected_count', label: 'Collected payments', align: 'right', money: false },
          { key: 'collected_amount', label: 'Collected amount', align: 'right', money: true },
          { key: 'refund_count', label: 'Refunds', align: 'right', money: false },
          { key: 'refund_amount', label: 'Refunded amount', align: 'right', money: true },
          { key: 'net_amount', label: 'Net amount', align: 'right', money: true },
        ],
        rows: rows.map((row: any) => ({
          ...row,
          collected_amount: money(row.collected_amount),
          refund_amount: money(row.refund_amount),
          net_amount: money(row.net_amount),
        })),
        totals: {
          method: 'Total',
          collected_count: sumCount(rows, 'collected_count'),
          collected_amount: sumMoney(rows, 'collected_amount'),
          refund_count: sumCount(rows, 'refund_count'),
          refund_amount: sumMoney(rows, 'refund_amount'),
          net_amount: sumMoney(rows, 'net_amount'),
        },
        unavailable: [],
      }
    }

    case 'shift-tender-reconciliation': {
      const sourceFilter = args.includeImported ? '' : `and s.source = 'pos'`
      const rows = await tx.$queryRawUnsafe(
        `with selected_shifts as (
           select sh.*
           from shifts sh
           where sh.tenant_id = $4::uuid
             and ${dateWindow('sh.opened_at')}
             and ($5::uuid is null or sh.store_id = $5::uuid)
         )
         select sh.id as shift_id,
                coalesce(st.name, 'Unattributed') as cashier,
                coalesce(term.name, 'Unassigned') as terminal,
                sh.starting_cash as opening_cash,
                count(distinct s.id)::int as sale_count,
                coalesce(sum(pay.amount) filter (where pay.direction = 'payment' and pay.method::text = 'cash'), 0) as cash_sales,
                coalesce(sum(abs(pay.amount)) filter (where pay.direction = 'refund' and pay.method::text = 'cash'), 0) as cash_refunds,
                (sh.starting_cash
                  + coalesce(sum(pay.amount) filter (where pay.direction = 'payment' and pay.method::text = 'cash'), 0)
                  - coalesce(sum(abs(pay.amount)) filter (where pay.direction = 'refund' and pay.method::text = 'cash'), 0)) as expected_cash,
                sh.counted_cash,
                sh.variance,
                coalesce(sum(pay.amount) filter (where pay.direction = 'payment' and pay.method::text = 'card'), 0) as card_sales,
                coalesce(sum(abs(pay.amount)) filter (where pay.direction = 'refund' and pay.method::text = 'card'), 0) as card_refunds,
                coalesce(sum(pay.amount) filter (where pay.direction = 'payment' and pay.method::text = 'check'), 0) as check_sales,
                coalesce(sum(abs(pay.amount)) filter (where pay.direction = 'refund' and pay.method::text = 'check'), 0) as check_refunds,
                coalesce(sum(pay.amount) filter (where pay.direction = 'payment' and pay.method::text not in ('cash', 'card', 'check')), 0) as other_sales,
                coalesce(sum(abs(pay.amount)) filter (where pay.direction = 'refund' and pay.method::text not in ('cash', 'card', 'check')), 0) as other_refunds,
                case when sh.closed_at is null then 'open' else 'closed' end as status
         from selected_shifts sh
         left join sales s
           on s.shift_id = sh.id
          and s.tenant_id = $4::uuid
          and s.store_id = sh.store_id
          ${sourceFilter}
         left join payments pay on pay.sale_id = s.id and pay.tenant_id = $4::uuid
         left join staff_members st on st.id = sh.staff_id and st.tenant_id = $4::uuid
         left join terminals term on term.id = sh.terminal_id and term.tenant_id = $4::uuid
         group by sh.id, st.name, term.name
         order by sh.opened_at desc`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        args.storeId,
      )

      const moneyKeys = [
        'opening_cash',
        'cash_sales',
        'cash_refunds',
        'expected_cash',
        'counted_cash',
        'variance',
        'card_sales',
        'card_refunds',
        'check_sales',
        'check_refunds',
        'other_sales',
        'other_refunds',
      ]
      const normalizedRows = rows.map((row: any) => {
        const normalized = { ...row }
        for (const key of moneyKeys) normalized[key] = row[key] === null ? null : money(row[key])
        return normalized
      })
      const hasOpenShift = normalizedRows.some((row: any) => row.status === 'open')

      return {
        ...base,
        columns: [
          { key: 'shift_id', label: 'Shift', align: 'left', money: false },
          { key: 'cashier', label: 'Cashier', align: 'left', money: false },
          { key: 'terminal', label: 'Terminal', align: 'left', money: false },
          { key: 'opening_cash', label: 'Opening cash', align: 'right', money: true },
          { key: 'cash_sales', label: 'Cash sales', align: 'right', money: true },
          { key: 'cash_refunds', label: 'Cash refunds', align: 'right', money: true },
          { key: 'expected_cash', label: 'Expected cash', align: 'right', money: true },
          { key: 'counted_cash', label: 'Counted cash', align: 'right', money: true },
          { key: 'variance', label: 'Variance', align: 'right', money: true },
          { key: 'card_sales', label: 'Card sales', align: 'right', money: true },
          { key: 'card_refunds', label: 'Card refunds', align: 'right', money: true },
          { key: 'check_sales', label: 'Check sales', align: 'right', money: true },
          { key: 'check_refunds', label: 'Check refunds', align: 'right', money: true },
          { key: 'other_sales', label: 'Other tender sales', align: 'right', money: true },
          { key: 'other_refunds', label: 'Other tender refunds', align: 'right', money: true },
          { key: 'status', label: 'Status', align: 'left', money: false },
        ],
        rows: normalizedRows,
        totals: {
          shift_id: 'Total',
          sale_count: sumCount(normalizedRows, 'sale_count'),
          opening_cash: sumMoney(normalizedRows, 'opening_cash'),
          cash_sales: sumMoney(normalizedRows, 'cash_sales'),
          cash_refunds: sumMoney(normalizedRows, 'cash_refunds'),
          expected_cash: sumMoney(normalizedRows, 'expected_cash'),
          counted_cash: hasOpenShift ? null : sumMoney(normalizedRows, 'counted_cash'),
          variance: hasOpenShift ? null : sumMoney(normalizedRows, 'variance'),
          card_sales: sumMoney(normalizedRows, 'card_sales'),
          card_refunds: sumMoney(normalizedRows, 'card_refunds'),
          check_sales: sumMoney(normalizedRows, 'check_sales'),
          check_refunds: sumMoney(normalizedRows, 'check_refunds'),
          other_sales: sumMoney(normalizedRows, 'other_sales'),
          other_refunds: sumMoney(normalizedRows, 'other_refunds'),
          status: hasOpenShift ? 'Open shifts included' : 'Closed',
        },
        unavailable: hasOpenShift
          ? [{ what: 'Counted cash and variance for open shifts', reason: 'An open shift has no counted cash until the drawer is closed.' }]
          : [],
      }
    }

    case 'purchases-by-supplier': {
      // PO totals are built per line and then per PO before supplier grouping.
      // This prevents one partial receipt from multiplying the ordered value.
      // Received value uses receipt-line costs; outstanding value uses the PO's
      // ordered unit cost and the quantity still outstanding at the end of the
      // selected business-date window.
      const rows = await tx.$queryRawUnsafe(
        `with receipt_by_line as (
           select rl.purchase_order_line_id,
                  coalesce(sum(rl.quantity_received), 0) as received_quantity,
                  coalesce(sum(rl.quantity_received * rl.unit_cost), 0) as received_value
           from purchase_order_receipt_lines rl
           join purchase_order_receipts r
             on r.id = rl.receipt_id
            and r.tenant_id = $4::uuid
           join purchase_orders receipt_po
             on receipt_po.id = r.purchase_order_id
            and receipt_po.tenant_id = $4::uuid
            and receipt_po.store_id = r.store_id
           join purchase_order_lines receipt_pol
             on receipt_pol.id = rl.purchase_order_line_id
            and receipt_pol.tenant_id = $4::uuid
            and receipt_pol.purchase_order_id = r.purchase_order_id
           where rl.tenant_id = $4::uuid
             and ${dateWindow('r.received_at')}
             and ($5::uuid is null or r.store_id = $5::uuid)
           group by rl.purchase_order_line_id
         ), po_rollup as (
           select po.id,
                  coalesce(sum(pol.quantity_ordered * pol.unit_cost), 0) as ordered_value,
                  coalesce(sum(coalesce(rbl.received_quantity, 0)), 0) as received_quantity,
                  coalesce(sum(coalesce(rbl.received_value, 0)), 0) as received_value,
                  coalesce(sum(greatest(pol.quantity_ordered - coalesce(rbl.received_quantity, 0), 0)), 0) as outstanding_quantity,
                  coalesce(sum(greatest(pol.quantity_ordered - coalesce(rbl.received_quantity, 0), 0) * pol.unit_cost), 0) as outstanding_value
           from purchase_orders po
           left join purchase_order_lines pol
             on pol.purchase_order_id = po.id
            and pol.tenant_id = $4::uuid
           left join receipt_by_line rbl on rbl.purchase_order_line_id = pol.id
           where po.tenant_id = $4::uuid
           group by po.id
         )
         select sup.id as supplier_id,
                sup.name as supplier,
                count(po.id)::int as po_count,
                coalesce(sum(pr.ordered_value), 0) as ordered_value,
                coalesce(sum(pr.received_quantity), 0) as received_quantity,
                coalesce(sum(pr.received_value), 0) as received_value,
                coalesce(sum(pr.outstanding_quantity), 0) as outstanding_quantity,
                coalesce(sum(pr.outstanding_value), 0) as outstanding_value,
                count(po.id) filter (where po.status = 'draft')::int as draft_count,
                count(po.id) filter (where po.status = 'sent')::int as sent_count,
                count(po.id) filter (where po.status = 'partial')::int as partial_count,
                count(po.id) filter (where po.status = 'received')::int as received_count,
                count(po.id) filter (where po.status = 'cancelled')::int as cancelled_count
         from purchase_orders po
         join suppliers sup on sup.id = po.supplier_id and sup.tenant_id = $4::uuid
         join po_rollup pr on pr.id = po.id
         where po.tenant_id = $4::uuid
           and ${dateWindow('po.created_at')}
           and ($5::uuid is null or po.store_id = $5::uuid)
         group by sup.id, sup.name
         order by ordered_value desc, sup.name`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        args.storeId,
      )

      return {
        ...base,
        description: 'Purchase orders created in this range. Received and outstanding quantities are measured from receipt events through the range end; receipt cost comes from receipt lines.',
        columns: [
          { key: 'supplier', label: 'Supplier', align: 'left', money: false },
          { key: 'po_count', label: 'POs', align: 'right', money: false },
          { key: 'ordered_value', label: 'Ordered value', align: 'right', money: true },
          { key: 'received_quantity', label: 'Quantity received', align: 'right', money: false },
          { key: 'received_value', label: 'Received value', align: 'right', money: true },
          { key: 'outstanding_quantity', label: 'Outstanding quantity', align: 'right', money: false },
          { key: 'outstanding_value', label: 'Outstanding ordered value', align: 'right', money: true },
          { key: 'draft_count', label: 'Draft', align: 'right', money: false },
          { key: 'sent_count', label: 'Sent', align: 'right', money: false },
          { key: 'partial_count', label: 'Partial', align: 'right', money: false },
          { key: 'received_count', label: 'Received', align: 'right', money: false },
          { key: 'cancelled_count', label: 'Cancelled', align: 'right', money: false },
        ],
        rows: rows.map((row: any) => ({
          ...row,
          ordered_value: money(row.ordered_value),
          received_quantity: money(row.received_quantity),
          received_value: money(row.received_value),
          outstanding_quantity: money(row.outstanding_quantity),
          outstanding_value: money(row.outstanding_value),
        })),
        totals: {
          supplier: 'Total',
          po_count: sumCount(rows, 'po_count'),
          ordered_value: sumMoney(rows, 'ordered_value'),
          received_quantity: sumMoney(rows, 'received_quantity'),
          received_value: sumMoney(rows, 'received_value'),
          outstanding_quantity: sumMoney(rows, 'outstanding_quantity'),
          outstanding_value: sumMoney(rows, 'outstanding_value'),
          draft_count: sumCount(rows, 'draft_count'),
          sent_count: sumCount(rows, 'sent_count'),
          partial_count: sumCount(rows, 'partial_count'),
          received_count: sumCount(rows, 'received_count'),
          cancelled_count: sumCount(rows, 'cancelled_count'),
        },
        unavailable: [],
      }
    }

    case 'goods-received-by-day': {
      const rows = await tx.$queryRawUnsafe(
        `select (r.received_at at time zone $3)::date::text as receipt_date,
                sup.name as supplier,
                po.po_number,
                count(distinct r.id)::int as receipt_count,
                coalesce(sum(rl.quantity_received), 0) as quantity_received,
                coalesce(sum(rl.quantity_received * rl.unit_cost), 0) as receipt_cost,
                case when bool_or(pol.quantity_received > pol.quantity_ordered) then 'Yes' else 'No' end as over_received
         from purchase_order_receipts r
         join purchase_orders po
           on po.id = r.purchase_order_id
          and po.tenant_id = $4::uuid
         join suppliers sup on sup.id = po.supplier_id and sup.tenant_id = $4::uuid
         join purchase_order_receipt_lines rl
           on rl.receipt_id = r.id
          and rl.tenant_id = $4::uuid
         join purchase_order_lines pol
           on pol.id = rl.purchase_order_line_id
          and pol.tenant_id = $4::uuid
          and pol.purchase_order_id = po.id
         where r.tenant_id = $4::uuid
           and ${dateWindow('r.received_at')}
           and ($5::uuid is null or r.store_id = $5::uuid)
         group by 1, sup.name, po.po_number
         order by 1 desc, sup.name, po.po_number`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        args.storeId,
      )

      return {
        ...base,
        columns: [
          { key: 'receipt_date', label: 'Receipt date', align: 'left', money: false },
          { key: 'supplier', label: 'Supplier', align: 'left', money: false },
          { key: 'po_number', label: 'PO number', align: 'left', money: false },
          { key: 'receipt_count', label: 'Receipts', align: 'right', money: false },
          { key: 'quantity_received', label: 'Quantity received', align: 'right', money: false },
          { key: 'receipt_cost', label: 'Receipt cost', align: 'right', money: true },
          { key: 'over_received', label: 'Over-received', align: 'left', money: false },
        ],
        rows: rows.map((row: any) => ({
          ...row,
          quantity_received: money(row.quantity_received),
          receipt_cost: money(row.receipt_cost),
        })),
        totals: {
          receipt_date: 'Total',
          receipt_count: sumCount(rows, 'receipt_count'),
          quantity_received: sumMoney(rows, 'quantity_received'),
          receipt_cost: sumMoney(rows, 'receipt_cost'),
          over_received: null,
        },
        unavailable: [],
      }
    }

    case 'purchase-cost-by-product': {
      const rows = await tx.$queryRawUnsafe(
        `select p.name as product,
                coalesce(nullif(concat_ws(' · ', v.size, v.color, v.material), ''), '') as variant,
                v.sku,
                coalesce(sum(rl.quantity_received), 0) as quantity_received,
                coalesce(sum(rl.quantity_received * rl.unit_cost), 0) as total_receipt_cost,
                case when sum(rl.quantity_received) = 0 then null
                     else sum(rl.quantity_received * rl.unit_cost) / sum(rl.quantity_received) end as weighted_average_received_unit_cost,
                v.moving_average_cost as current_moving_average_cost
         from purchase_order_receipt_lines rl
         join purchase_order_receipts r
           on r.id = rl.receipt_id
          and r.tenant_id = $4::uuid
         join purchase_order_lines pol
           on pol.id = rl.purchase_order_line_id
          and pol.tenant_id = $4::uuid
          and pol.purchase_order_id = r.purchase_order_id
         join variants v on v.id = rl.variant_id and v.tenant_id = $4::uuid
         join products p on p.id = v.product_id and p.tenant_id = $4::uuid
         where rl.tenant_id = $4::uuid
           and ${dateWindow('r.received_at')}
           and ($5::uuid is null or r.store_id = $5::uuid)
         group by p.name, v.id, v.size, v.color, v.material, v.sku, v.moving_average_cost
         order by total_receipt_cost desc, p.name, v.sku`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        args.storeId,
      )

      const normalizedRows = rows.map((row: any) => ({
        ...row,
        quantity_received: money(row.quantity_received),
        total_receipt_cost: money(row.total_receipt_cost),
        weighted_average_received_unit_cost:
          row.weighted_average_received_unit_cost === null ? null : money(row.weighted_average_received_unit_cost),
        current_moving_average_cost: row.current_moving_average_cost === null ? null : money(row.current_moving_average_cost),
      }))
      const quantityTotal = sumMoney(rows, 'quantity_received')
      const costTotal = sumMoney(rows, 'total_receipt_cost')

      return {
        ...base,
        columns: [
          { key: 'product', label: 'Product', align: 'left', money: false },
          { key: 'variant', label: 'Variant', align: 'left', money: false },
          { key: 'sku', label: 'SKU', align: 'left', money: false },
          { key: 'quantity_received', label: 'Quantity received', align: 'right', money: false },
          { key: 'total_receipt_cost', label: 'Total receipt cost', align: 'right', money: true },
          { key: 'weighted_average_received_unit_cost', label: 'Weighted average receipt cost', align: 'right', money: true },
          { key: 'current_moving_average_cost', label: 'Current moving-average cost', align: 'right', money: true },
        ],
        rows: normalizedRows,
        totals: {
          product: 'Total',
          quantity_received: quantityTotal,
          total_receipt_cost: costTotal,
          weighted_average_received_unit_cost: quantityTotal === 0 ? null : new Prisma.Decimal(costTotal).div(quantityTotal).toNumber(),
          current_moving_average_cost: null,
        },
        unavailable: [],
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
           ${movementStoreFilter}
         order by m.created_at desc limit 1000`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        ...(args.storeId ? [args.storeId] : []),
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
         join sales s on s.id = pay.sale_id
         left join staff_members st on st.id = pay.created_by
         where pay.tenant_id = $4::uuid and pay.direction = 'refund'
           and pay.created_at >= (($1::date)::timestamp at time zone $3)
           and pay.created_at < ((($2::date) + 1)::timestamp at time zone $3)
           ${salesStoreFilter}
         group by 1`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        ...(args.storeId ? [args.storeId] : []),
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
         where s.tenant_id = $4::uuid and ${window} ${sourceFilter} ${salesStoreFilter}
         group by 1`,
        args.from,
        args.to,
        args.zone,
        args.tenantId,
        ...(args.storeId ? [args.storeId] : []),
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
