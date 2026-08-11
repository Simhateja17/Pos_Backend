import { describe, expect, it, vi } from 'vitest'
import { buildReport } from '../../src/routes/reports'
import { ReportCatalogSchema, ReportKindSchema } from '../../src/contracts/schemas/reports'

describe('report SQL stays aligned with the category schema', () => {
  it('resolves category labels through categories instead of the removed products.category column', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([])

    await buildReport(
      { $queryRawUnsafe: queryRawUnsafe },
      {
        kind: 'sales-by-category',
        storeId: null,
      tenantId: '11111111-1111-4111-8111-111111111111',
        zone: 'UTC',
        from: '2026-08-01',
        to: '2026-08-07',
        includeImported: true,
      },
    )

    const sql = String(queryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain("coalesce(c.name, 'Uncategorised')")
    expect(sql).toContain('left join categories c on c.id = p.category_id')
    expect(sql).not.toMatch(/\bp\.category\b/)
  })

  it('adds the selected store to sales report SQL instead of returning tenant-wide totals', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([])
    const storeId = '22222222-2222-4222-8222-222222222222'

    await buildReport(
      { $queryRawUnsafe: queryRawUnsafe },
      {
        kind: 'sales-by-day',
        storeId,
        tenantId: '11111111-1111-4111-8111-111111111111',
        zone: 'UTC',
        from: '2026-08-01',
        to: '2026-08-07',
        includeImported: true,
      },
    )

    const [sql, ...params] = queryRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('s.store_id = $5::uuid')
    expect(params).toContain(storeId)
  })
})

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'

function args(kind: Parameters<typeof buildReport>[1]['kind'], overrides: Partial<Parameters<typeof buildReport>[1]> = {}) {
  return {
    kind,
    storeId: null,
    tenantId,
    zone: 'Asia/Kolkata',
    from: '2026-08-01',
    to: '2026-08-07',
    includeImported: true,
    ...overrides,
  }
}

describe('India MVP operational reports', () => {
  it('exposes the six fixed kinds and the payment/purchases catalog groups', () => {
    expect(ReportKindSchema.safeParse('payments-by-method').success).toBe(true)
    expect(ReportKindSchema.safeParse('purchase-cost-by-product').success).toBe(true)
    expect(
      ReportCatalogSchema.safeParse({
        reports: [
          { kind: 'payments-by-method', title: 'Payments', description: 'x', group: 'payments' },
          { kind: 'purchases-by-supplier', title: 'Purchases', description: 'x', group: 'purchases' },
        ],
      }).success,
    ).toBe(true)
  })

  it('keeps collected, refunded and net tender amounts separate and store scoped', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([
      { method: 'cash', collected_count: 2, collected_amount: '100.10', refund_count: 1, refund_amount: '10.10', net_amount: '90.00' },
      { method: 'upi', collected_count: 1, collected_amount: '50.00', refund_count: 0, refund_amount: '0.00', net_amount: '50.00' },
    ])

    const report = await buildReport(
      { $queryRawUnsafe: queryRawUnsafe },
      args('payments-by-method', { storeId }),
    )

    expect(report.rows).toEqual([
      expect.objectContaining({ method: 'cash', collected_amount: 100.1, refund_amount: 10.1, net_amount: 90 }),
      expect.objectContaining({ method: 'upi', collected_amount: 50, refund_amount: 0, net_amount: 50 }),
    ])
    expect(report.totals).toEqual(expect.objectContaining({ collected_count: 3, collected_amount: 150.1, refund_count: 1, refund_amount: 10.1, net_amount: 140 }))
    const [sql, ...params] = queryRawUnsafe.mock.calls[0]
    expect(String(sql)).toContain('pay.created_at >= (($1::date)::timestamp at time zone $3)')
    expect(String(sql)).toContain('($5::uuid is null or s.store_id = $5::uuid)')
    expect(params).toContain(storeId)
  })

  it('shows an open shift without fabricating counted cash or variance', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        shift_id: '33333333-3333-4333-8333-333333333333',
        cashier: 'Asha',
        terminal: 'Front counter',
        opening_cash: '500.00',
        sale_count: 2,
        cash_sales: '100.00',
        cash_refunds: '10.00',
        expected_cash: '590.00',
        counted_cash: null,
        variance: null,
        card_sales: '50.00',
        card_refunds: '0.00',
        check_sales: '0.00',
        check_refunds: '0.00',
        other_sales: '25.00',
        other_refunds: '5.00',
        status: 'open',
      },
    ])

    const report = await buildReport({ $queryRawUnsafe: queryRawUnsafe }, args('shift-tender-reconciliation'))

    expect(report.rows[0]).toEqual(expect.objectContaining({ expected_cash: 590, counted_cash: null, variance: null, other_sales: 25, other_refunds: 5 }))
    expect(report.totals).toEqual(expect.objectContaining({ expected_cash: 590, counted_cash: null, variance: null }))
    expect(report.unavailable).toEqual([
      expect.objectContaining({ what: 'Counted cash and variance for open shifts' }),
    ])
    expect(String(queryRawUnsafe.mock.calls[0][0])).toContain('selected_shifts')
    expect(String(queryRawUnsafe.mock.calls[0][0])).toContain("pay.method::text not in ('cash', 'card', 'check')")
  })

  it('rolls partial receipts up once per PO and keeps ordered and received values distinct', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        supplier_id: '44444444-4444-4444-8444-444444444444',
        supplier: 'Mumbai Textiles',
        po_count: 1,
        ordered_value: '1000.00',
        received_quantity: '4.000',
        received_value: '420.00',
        outstanding_quantity: '6.000',
        outstanding_value: '600.00',
        draft_count: 0,
        sent_count: 0,
        partial_count: 1,
        received_count: 0,
        cancelled_count: 0,
      },
    ])

    const report = await buildReport({ $queryRawUnsafe: queryRawUnsafe }, args('purchases-by-supplier', { storeId }))

    expect(report.rows[0]).toEqual(expect.objectContaining({ ordered_value: 1000, received_value: 420, outstanding_quantity: 6, outstanding_value: 600 }))
    expect(report.totals).toEqual(expect.objectContaining({ ordered_value: 1000, received_value: 420, outstanding_value: 600, partial_count: 1 }))
    const sql = String(queryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('receipt_by_line')
    expect(sql).toContain('greatest(pol.quantity_ordered - coalesce(rbl.received_quantity, 0), 0)')
    expect(sql).toContain('po.store_id = $5::uuid')
  })

  it('reports receipt events by business day and surfaces over-receipt', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        receipt_date: '2026-08-03',
        supplier: 'Mumbai Textiles',
        po_number: 'PO-0001',
        receipt_count: 1,
        quantity_received: '12.500',
        receipt_cost: '1375.00',
        over_received: 'Yes',
      },
    ])

    const report = await buildReport({ $queryRawUnsafe: queryRawUnsafe }, args('goods-received-by-day'))

    expect(report.rows[0]).toEqual(expect.objectContaining({ receipt_date: '2026-08-03', quantity_received: 12.5, receipt_cost: 1375, over_received: 'Yes' }))
    expect(report.totals).toEqual(expect.objectContaining({ quantity_received: 12.5, receipt_cost: 1375 }))
    expect(String(queryRawUnsafe.mock.calls[0][0])).toContain("case when bool_or(pol.quantity_received > pol.quantity_ordered) then 'Yes'")
    expect(String(queryRawUnsafe.mock.calls[0][0])).toContain('r.received_at >= (($1::date)::timestamp at time zone $3)')
  })

  it('uses receipt-line costs for weighted product cost and keeps current cost separate', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        product: 'Cotton Kurta',
        variant: 'M · Blue',
        sku: 'K-M-BLUE',
        quantity_received: '10.000',
        total_receipt_cost: '1250.00',
        weighted_average_received_unit_cost: '125.00',
        current_moving_average_cost: '127.50',
      },
    ])

    const report = await buildReport({ $queryRawUnsafe: queryRawUnsafe }, args('purchase-cost-by-product'))

    expect(report.rows[0]).toEqual(expect.objectContaining({ quantity_received: 10, total_receipt_cost: 1250, weighted_average_received_unit_cost: 125, current_moving_average_cost: 127.5 }))
    expect(report.totals).toEqual(expect.objectContaining({ quantity_received: 10, total_receipt_cost: 1250, weighted_average_received_unit_cost: 125, current_moving_average_cost: null }))
    const sql = String(queryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('rl.quantity_received * rl.unit_cost')
    expect(sql).toContain('v.moving_average_cost as current_moving_average_cost')
  })
})
