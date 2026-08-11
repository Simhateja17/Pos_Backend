import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const DESTINATION = '22222222-2222-4222-8222-222222222222'
const VARIANT = '33333333-3333-4333-8333-333333333333'
const TRANSFER = '44444444-4444-4444-8444-444444444444'
const LINE = '55555555-5555-4555-8555-555555555555'
const CLIENT_SEND = '66666666-6666-4666-8666-666666666666'
const CLIENT_RECEIVE = '77777777-7777-4777-8777-777777777777'

const transferFindFirst = vi.fn()
const transferCreate = vi.fn()
const transferUpdate = vi.fn()
const lineFindMany = vi.fn()
const lineCreate = vi.fn()
const lineUpdate = vi.fn()
const movementCreate = vi.fn()
const storesFindFirst = vi.fn()
const storesFindMany = vi.fn()
const variantsFindMany = vi.fn()
const queryRaw = vi.fn()

const tx = {
  $queryRaw: queryRaw,
  stock_transfers: { findFirst: transferFindFirst, create: transferCreate, update: transferUpdate },
  stock_transfer_lines: { findMany: lineFindMany, create: lineCreate, update: lineUpdate },
  stock_movements: { create: movementCreate },
  stores: { findFirst: storesFindFirst, findMany: storesFindMany },
  variants: { findMany: variantsFindMany },
}

vi.mock('../../src/db/tenantClient', () => ({
  forTenantTransaction: vi.fn(async (_tenantId: string, callback: (client: any) => Promise<any>) => callback(tx)),
  forTenant: vi.fn(() => tx),
}))

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSFER,
    tenant_id: 'tenant-1',
    from_store_id: SOURCE,
    to_store_id: DESTINATION,
    status: 'sent',
    client_transfer_id: CLIENT_SEND,
    client_receive_id: null,
    note: null,
    sent_at: new Date('2026-08-10T10:00:00Z'),
    received_at: null,
    ...overrides,
  }
}

async function app(activeStoreId = SOURCE) {
  const { default: router } = await import('../../src/routes/transfers')
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => {
    req.user = { id: 'user-1', tenantId: 'tenant-1', role: 'owner', storeId: SOURCE }
    req.actingStaff = { id: 'staff-1', role: 'owner' }
    req.storeContext = { scope: 'store', activeStoreId, actingRemotely: activeStoreId !== SOURCE }
    next()
  })
  server.use('/transfers', router)
  return server
}

describe('stock transfer routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    storesFindFirst.mockResolvedValue({ id: DESTINATION })
    storesFindMany.mockResolvedValue([
      { id: SOURCE, name: 'Andheri' },
      { id: DESTINATION, name: 'Bandra' },
    ])
    variantsFindMany.mockResolvedValue([{ id: VARIANT, sku: 'BLUE-M' }])
    lineFindMany.mockResolvedValue([
      { id: LINE, transfer_id: TRANSFER, variant_id: VARIANT, quantity_sent: 5, quantity_received: null },
    ])
  })

  it('sends stock atomically with a negative source movement', async () => {
    transferFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row())
    transferCreate.mockResolvedValue(row())
    lineCreate.mockResolvedValue({ id: LINE })
    movementCreate.mockResolvedValue({ id: 'movement-1' })

    const response = await request(await app()).post('/transfers').send({
      clientTransferId: CLIENT_SEND,
      toStoreId: DESTINATION,
      lines: [{ variantId: VARIANT, quantitySent: 5 }],
    })

    expect(response.status).toBe(201)
    expect(lineCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ transfer_id: TRANSFER, variant_id: VARIANT, quantity_sent: 5 }),
    }))
    expect(movementCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        store_id: SOURCE,
        variant_id: VARIANT,
        movement_type: 'transfer',
        quantity_delta: -5,
        reference_id: TRANSFER,
      }),
    }))
  })

  it('receives the counted quantity at the destination and preserves the discrepancy', async () => {
    transferFindFirst
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: 'received', client_receive_id: CLIENT_RECEIVE, received_at: new Date('2026-08-10T11:00:00Z') }))
    lineFindMany
      .mockResolvedValueOnce([{ id: LINE, transfer_id: TRANSFER, variant_id: VARIANT, quantity_sent: 5, quantity_received: null }])
      .mockResolvedValueOnce([{ id: LINE, transfer_id: TRANSFER, variant_id: VARIANT, quantity_sent: 5, quantity_received: 4 }])
    queryRaw.mockResolvedValue([{ id: TRANSFER }])
    lineUpdate.mockResolvedValue({ id: LINE })
    transferUpdate.mockResolvedValue(row({ status: 'received' }))
    movementCreate.mockResolvedValue({ id: 'movement-2' })

    const response = await request(await app(DESTINATION)).post(`/transfers/${TRANSFER}/receive`).send({
      clientReceiveId: CLIENT_RECEIVE,
      lines: [{ transferLineId: LINE, quantityReceived: 4 }],
    })

    expect(response.status).toBe(201)
    expect(movementCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ store_id: DESTINATION, quantity_delta: 4 }),
    }))
    expect(transferUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'received', client_receive_id: CLIENT_RECEIVE }),
    }))
    expect(response.body.lines[0].discrepancy).toBe('1')
  })
})
