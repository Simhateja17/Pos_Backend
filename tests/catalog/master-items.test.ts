import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const tenantFindFirst = vi.fn()
const masterFindMany = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    tenants: { findFirst: tenantFindFirst },
    master_items: { findMany: masterFindMany },
  })),
}))

describe('regional master item autocomplete', () => {
  beforeEach(() => {
    tenantFindFirst.mockReset().mockResolvedValue({ country: 'IN' })
    masterFindMany.mockReset().mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222', canonical_name: 'Milk', brand: 'Sangam', category: 'Dairy', subcategory: 'Milk', pack_size: '500', unit: 'ml', sell_unit: 'piece', barcode: null, aliases: ['milk'] },
      { id: '11111111-1111-4111-8111-111111111111', canonical_name: 'Toned Milk', brand: 'Nandini', category: 'Dairy', subcategory: 'Milk', pack_size: '500', unit: 'ml', sell_unit: 'piece', barcode: null, aliases: ['milk', 'nandini milk'] },
    ])
  })

  async function app() {
    const { default: router } = await import('../../src/routes/masterItems')
    const server = express()
    server.use((req, _res, next) => {
      req.user = { id: 'user-1', role: 'manager', tenantId: 'tenant-1', storeId: 'store-1' }
      next()
    })
    server.use('/master-items', router)
    return server
  }

  it('returns ranked identity-only India suggestions', async () => {
    const res = await request(await app()).get('/master-items').query({ query: 'milk', limit: 10 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      expect.objectContaining({ displayName: 'Sangam Milk 500 ml', packUnit: 'ml', sellUnit: 'piece' }),
      expect.objectContaining({ displayName: 'Nandini Toned Milk 500 ml', packUnit: 'ml', sellUnit: 'piece' }),
    ])
    expect(masterFindMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ region: 'IN', is_active: true }))
    expect(res.body[0]).not.toHaveProperty('mrp')
    expect(res.body[0]).not.toHaveProperty('hsnSac')
  })

  it('does not search on a one-character query', async () => {
    const res = await request(await app()).get('/master-items').query({ query: 'm' })
    expect(res.status).toBe(400)
    expect(masterFindMany).not.toHaveBeenCalled()
  })
})
