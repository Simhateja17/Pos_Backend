import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const shiftsFindFirstMock = vi.fn()
const salesFindFirstMock = vi.fn()

const tx = {
  shifts: { findFirst: shiftsFindFirstMock },
  sales: { findFirst: salesFindFirstMock },
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({})),
  forTenantTransaction: vi.fn(async (_tenantId: string, action: (client: typeof tx) => Promise<unknown>) => action(tx)),
}))

vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(async () => null),
}))

vi.mock('../../src/services/taxDocuments', () => ({
  createCreditNoteForReturn: vi.fn(),
  ensureTaxInvoice: vi.fn(),
}))

describe('return submission store scope', () => {
  beforeEach(() => {
    shiftsFindFirstMock.mockReset().mockResolvedValue({
      id: '21111111-1111-4111-8111-111111111111',
      store_id: 'store-s2',
      terminal_id: null,
      closed_at: null,
    })
    salesFindFirstMock.mockReset().mockResolvedValue(null)
  })

  it('does not resolve a sale from another store', async () => {
    const { default: returnsRouter } = await import('../../src/routes/returns')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', tenantId: 'tenant-1', storeId: 'store-s2', role: 'owner' }
      req.storeContext = { scope: 'store', activeStoreId: 'store-s2', actingRemotely: false }
      next()
    })
    app.use('/returns', returnsRouter)

    const response = await request(app).post('/returns').send({
      returnReferenceId: '11111111-1111-4111-8111-111111111111',
      saleId: '31111111-1111-4111-8111-111111111111',
      shiftId: '21111111-1111-4111-8111-111111111111',
      reason: 'Wrong size',
      lines: [{ saleLineItemId: '41111111-1111-4111-8111-111111111111', quantity: 1 }],
      refundPayments: [{ method: 'cash', amount: '118.00' }],
    })

    expect(response.status).toBe(404)
    expect(salesFindFirstMock).toHaveBeenCalledWith({
      where: { id: '31111111-1111-4111-8111-111111111111', store_id: 'store-s2' },
    })
  })
})
