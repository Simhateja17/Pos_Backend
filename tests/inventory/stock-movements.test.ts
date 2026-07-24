import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = 'anon-key'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string) => ({ auth: { getUser: getUserMock } })),
}))

const stockMovementsCreateMock = vi.fn()
const stockMovementsFindManyMock = vi.fn()
const staffMembersFindFirstMock = vi.fn()
const variantsFindFirstMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    stock_movements: {
      create: stockMovementsCreateMock,
      findMany: stockMovementsFindManyMock,
    },
    staff_members: {
      findFirst: staffMembersFindFirstMock,
    },
    variants: {
      findFirst: variantsFindFirstMock,
    },
  })),
}))

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesignature`
}

function tokenFor(role: 'owner' | 'manager' | 'cashier', tenantId = 'tenant-abc') {
  return fakeJwt({ sub: 'user-123', role, tenant_id: tenantId })
}

describe('stock-movements routes (INV-01)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    stockMovementsCreateMock.mockReset()
    stockMovementsFindManyMock.mockReset()
    staffMembersFindFirstMock.mockReset()
    variantsFindFirstMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    staffMembersFindFirstMock.mockResolvedValue({ id: 'staff-1' })
    // CR-01: the caller's tenant-scoped variant lookup finds the variant by
    // default; individual tests override to null to simulate a cross-tenant
    // (not found) variant.
    variantsFindFirstMock.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
  })

  async function buildApp() {
    const { authMiddleware } = await import('../../src/middleware/auth')
    const { default: stockMovementsRouter } = await import('../../src/routes/stockMovements')
    const app = express()
    app.use(express.json())
    app.use('/stock-movements', authMiddleware, stockMovementsRouter)
    return app
  }

  it('Test 1: POST /stock-movements adjustment with cashier JWT returns 403; manager JWT returns 201', async () => {
    const app = await buildApp()

    const cashierRes = await request(app)
      .post('/stock-movements')
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)
      .send({ variantId: '11111111-1111-4111-8111-111111111111', movementType: 'adjustment', quantityDelta: -2, reasonCode: 'damage' })
    expect(cashierRes.status).toBe(403)
    expect(stockMovementsCreateMock).not.toHaveBeenCalled()

    stockMovementsCreateMock.mockResolvedValue({
      id: 'move-1',
      variant_id: '11111111-1111-4111-8111-111111111111',
      movement_type: 'adjustment',
      quantity_delta: -2,
      reason_code: 'damage',
      reason_note: null,
      created_by: 'staff-1',
      created_at: new Date('2026-01-01T00:00:00Z'),
    })

    const managerRes = await request(app)
      .post('/stock-movements')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)
      .send({ variantId: '11111111-1111-4111-8111-111111111111', movementType: 'adjustment', quantityDelta: -2, reasonCode: 'damage' })
    expect(managerRes.status).toBe(201)
    expect(managerRes.body.movementType).toBe('adjustment')
  })

  it('Test 2: POST /stock-movements receive with cashier JWT returns 201 (D-13 only gates adjustment)', async () => {
    stockMovementsCreateMock.mockResolvedValue({
      id: 'move-2',
      variant_id: '11111111-1111-4111-8111-111111111111',
      movement_type: 'receive',
      quantity_delta: 10,
      reason_code: null,
      reason_note: null,
      created_by: 'staff-1',
      created_at: new Date('2026-01-02T00:00:00Z'),
    })

    const app = await buildApp()
    const res = await request(app)
      .post('/stock-movements')
      .set('Authorization', `Bearer ${tokenFor('cashier')}`)
      .send({ variantId: '11111111-1111-4111-8111-111111111111', movementType: 'receive', quantityDelta: 10 })

    expect(res.status).toBe(201)
    expect(stockMovementsCreateMock).toHaveBeenCalled()
  })

  it('Test 2b: POST /stock-movements adjustment with no reasonCode returns 400', async () => {
    const app = await buildApp()
    const res = await request(app)
      .post('/stock-movements')
      .set('Authorization', `Bearer ${tokenFor('manager')}`)
      .send({ variantId: '11111111-1111-4111-8111-111111111111', movementType: 'adjustment', quantityDelta: -1 })

    expect(res.status).toBe(400)
    expect(stockMovementsCreateMock).not.toHaveBeenCalled()
  })

  it('Test 3: stockMovements.ts contains neither router.patch( nor router.delete( — no mutation route exists for the ledger', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/routes/stockMovements.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/router\.(patch|delete)\(/)
  })

  it('Test 4: GET /stock-movements?variantId=X returns the mocked history mapped to camelCase, ordered by created_at desc', async () => {
    stockMovementsFindManyMock.mockResolvedValue([
      {
        id: 'move-3',
        variant_id: '11111111-1111-4111-8111-111111111111',
        movement_type: 'receive',
        quantity_delta: 10,
        reason_code: null,
        reason_note: null,
        created_by: 'staff-1',
        created_at: new Date('2026-01-03T00:00:00Z'),
      },
    ])

    const app = await buildApp()
    const res = await request(app)
      .get('/stock-movements')
      .query({ variantId: '11111111-1111-4111-8111-111111111111' })
      .set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        id: 'move-3',
        variantId: '11111111-1111-4111-8111-111111111111',
        movementType: 'receive',
        quantityDelta: 10,
        reasonCode: null,
        reasonNote: null,
        createdBy: 'staff-1',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ])
    expect(stockMovementsFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { variant_id: '11111111-1111-4111-8111-111111111111' },
        orderBy: { created_at: 'desc' },
      }),
    )
  })

  it('Test 5 (CR-01): POST /stock-movements with a variantId that does not resolve within the caller\'s own tenant returns 404 and never inserts', async () => {
    variantsFindFirstMock.mockResolvedValue(null)

    const app = await buildApp()
    const res = await request(app)
      .post('/stock-movements')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ variantId: '22222222-2222-4222-8222-222222222222', movementType: 'receive', quantityDelta: 5 })

    expect(res.status).toBe(404)
    expect(stockMovementsCreateMock).not.toHaveBeenCalled()
  })
})
