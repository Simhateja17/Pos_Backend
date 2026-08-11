import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { resetRateLimits } from '../../src/lib/rateLimit'

const salesFindFirstMock = vi.fn()
const customersFindFirstMock = vi.fn()
const tenantsFindFirstMock = vi.fn()
const sendLoggedEmailMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    sales: { findFirst: salesFindFirstMock },
    customers: { findFirst: customersFindFirstMock },
    tenants: { findFirst: tenantsFindFirstMock },
  })),
}))

vi.mock('../../src/services/email', () => ({
  sendLoggedEmail: sendLoggedEmailMock,
}))

function buildApp(role: 'owner' | 'manager' | 'cashier' = 'cashier') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', role, tenantId: 'tenant-1', storeId: 'store-1', }
    next()
  })
  return import('../../src/routes/sales').then(({ default: salesRouter }) => {
    return import('../../src/middleware/storeContext').then(({ storeContextMiddleware }) => {
      app.use('/sales', storeContextMiddleware, salesRouter)
      return app
    })
  })
}

describe('receipt resend safeguards', () => {
  beforeEach(() => {
    vi.resetModules()
    resetRateLimits()
    salesFindFirstMock.mockReset().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      customer_id: 'customer-1',
      total_amount: { toString: () => '100.00' },
    })
    customersFindFirstMock.mockReset().mockResolvedValue({ email: 'buyer@example.com' })
    tenantsFindFirstMock.mockReset().mockResolvedValue({ business_name: 'Example Store' })
    sendLoggedEmailMock.mockReset().mockResolvedValue({ status: 'sent', logId: 'email-1' })
  })

  it('does not let a cashier redirect a receipt to an arbitrary address', async () => {
    const app = await buildApp('cashier')
    const response = await request(app)
      .post('/sales/11111111-1111-4111-8111-111111111111/resend-receipt')
      .send({ email: 'attacker@example.com' })

    expect(response.status).toBe(403)
    expect(sendLoggedEmailMock).not.toHaveBeenCalled()
  })

  it('uses the on-file address and throttles repeated sends for the same sale', async () => {
    const app = await buildApp('cashier')
    const path = '/sales/11111111-1111-4111-8111-111111111111/resend-receipt'

    const first = await request(app).post(path).send({})
    const second = await request(app).post(path).send({})

    expect(first.status).toBe(200)
    expect(first.body.email).toBe('buyer@example.com')
    expect(second.status).toBe(429)
    expect(second.headers['retry-after']).toBeDefined()
    expect(sendLoggedEmailMock).toHaveBeenCalledTimes(1)
  })

  it('allows a manager-approved alternate address and records the acting staff id', async () => {
    const app = await buildApp('manager')
    const response = await request(app)
      .post('/sales/11111111-1111-4111-8111-111111111111/resend-receipt')
      .send({ email: 'alternate@example.com' })

    expect(response.status).toBe(200)
    expect(sendLoggedEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alternate@example.com',
      createdBy: 'user-1',
    }))
  })
})
