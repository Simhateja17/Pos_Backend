import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'

process.env.SUPABASE_JWT_SECRET = 'test-secret-for-operator-context-unit-tests'

import { operatorContext } from '../../src/middleware/operatorContext'
import { signOperatorToken } from '../../src/middleware/pinSwitch'

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

function mockRes(): Response {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as Response
}

describe('operatorContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Test 1: valid X-Operator-Token -> req.actingStaff set from verified claims, next() called', () => {
    const token = signOperatorToken({ id: 'staff-1', role: 'cashier' })
    const req = mockReq({ 'x-operator-token': token })
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(req.actingStaff).toEqual({ id: 'staff-1', role: 'cashier' })
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('Test 2: no X-Operator-Token header -> req.actingStaff left undefined, next() called', () => {
    const req = mockReq({})
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(req.actingStaff).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('Test 3: garbage/tampered X-Operator-Token -> 401, next() NOT called', () => {
    const req = mockReq({ 'x-operator-token': 'garbage.tampered.token' })
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid operator session' })
  })
})
