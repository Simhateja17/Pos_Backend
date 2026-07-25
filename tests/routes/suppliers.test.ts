import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const findManyMock = vi.fn()
const findFirstMock = vi.fn()
const createMock = vi.fn()
const updateMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    suppliers: {
      findMany: findManyMock,
      findFirst: findFirstMock,
      create: createMock,
      update: updateMock,
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

const supplierRow = {
  id: 'sup-1',
  name: 'Fabindia Mills',
  contact_name: 'Ravi',
  email: 'ravi@fabindia.example',
  phone: '+91-9000000000',
  address: '12 Mill Road',
  lead_time_days: 5,
  min_order_value: { toString: () => '5000.00' },
  payment_terms: 'Net 30',
  is_active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
}

describe('suppliers routes', () => {
  beforeEach(() => {
    findManyMock.mockReset()
    findFirstMock.mockReset()
    createMock.mockReset()
    updateMock.mockReset()
  })

  async function buildApp() {
    // authMiddleware is mocked out here — this file proves the route's own
    // request/response contract; real-Supabase JWT verification is covered
    // by auth.test.ts, and cross-tenant DB enforcement by
    // tests/tenancy/suppliers-rls.test.ts.
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      const header = req.headers.authorization
      const token = header?.replace('Bearer ', '')
      if (token) {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
        ;(req as any).user = { tenantId: payload.tenant_id, role: payload.role }
      }
      next()
    })
    const { default: suppliersRouter } = await import('../../src/routes/suppliers')
    app.use('/suppliers', suppliersRouter)
    return app
  }

  it('Test 1: GET / returns the tenant supplier list, serialized camelCase', async () => {
    findManyMock.mockResolvedValue([supplierRow])
    const app = await buildApp()

    const res = await request(app).get('/suppliers').set('Authorization', `Bearer ${tokenFor('owner')}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        id: 'sup-1',
        name: 'Fabindia Mills',
        contactName: 'Ravi',
        email: 'ravi@fabindia.example',
        phone: '+91-9000000000',
        address: '12 Mill Road',
        leadTimeDays: 5,
        minOrderValue: '5000.00',
        paymentTerms: 'Net 30',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })

  it('Test 2: POST / rejects a request with no leadTimeDays (required — direct reorder-formula input)', async () => {
    const app = await buildApp()
    const res = await request(app)
      .post('/suppliers')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ name: 'No Lead Time Supplier' })

    expect(res.status).toBe(400)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('Test 3: POST / with a valid body creates the supplier scoped to the caller tenant', async () => {
    createMock.mockResolvedValue(supplierRow)
    const app = await buildApp()

    const res = await request(app)
      .post('/suppliers')
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ name: 'Fabindia Mills', leadTimeDays: 5 })

    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenant_id: 'tenant-abc', lead_time_days: 5 }) }),
    )
  })

  it('Test 4: PATCH /:supplierId with isActive:false deactivates rather than deletes — no delete route exists', async () => {
    findFirstMock.mockResolvedValue(supplierRow)
    updateMock.mockResolvedValue({ ...supplierRow, is_active: false })
    const app = await buildApp()

    const res = await request(app)
      .patch(`/suppliers/${'11111111-1111-4111-8111-111111111111'}`)
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ isActive: false })

    expect(res.status).toBe(200)
    expect(res.body.isActive).toBe(false)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ is_active: false }) }))
  })

  it('Test 5: PATCH /:supplierId for a supplier not found in the tenant returns 404', async () => {
    findFirstMock.mockResolvedValue(null)
    const app = await buildApp()

    const res = await request(app)
      .patch(`/suppliers/${'11111111-1111-4111-8111-111111111111'}`)
      .set('Authorization', `Bearer ${tokenFor('owner')}`)
      .send({ name: 'New Name' })

    expect(res.status).toBe(404)
  })
})
