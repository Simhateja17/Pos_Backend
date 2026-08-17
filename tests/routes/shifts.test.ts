import { describe, expect, it, vi } from 'vitest'
import { computeXReport } from '../../src/routes/shifts'

describe('shift X report tender totals', () => {
  it('reports UPI sales separately without adding them to expected cash', async () => {
    const report = await computeXReport(
      {
        sales: { findMany: vi.fn().mockResolvedValue([{ id: 'cash-sale' }, { id: 'upi-sale' }]) },
        payments: {
          findMany: vi.fn().mockResolvedValue([
            { direction: 'payment', method: 'cash', amount: '50.00' },
            { direction: 'payment', method: 'upi', amount: '125.50' },
          ]),
        },
      },
      { id: 'shift-1', starting_cash: '100.00' },
    )

    expect(report).toMatchObject({
      expectedCash: '150',
      cashSalesTotal: '50',
      cardSalesTotal: '0',
      upiSalesTotal: '125.5',
      checkSalesTotal: '0',
      refundsTotal: '0',
      saleCount: 2,
    })
  })
})
