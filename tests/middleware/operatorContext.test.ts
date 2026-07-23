import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'

process.env.SUPABASE_JWT_SECRET = 'test-secret-for-operator-context-unit-tests'

import { operatorContext } from '../../src/middleware/operatorContext'
import { signOperatorToken } from '../../src/middleware/pinSwitch'

function mockReq(
  headers: Record<string, string> = {},
  user?: { id: string; role: 'owner' | 'manager' | 'cashier'; tenantId: string },
): Request {
  return { headers, user } as unknown as Request
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

  it('Test 1: valid X-Operator-Token whose tenant_id matches req.user.tenantId -> req.actingStaff set from verified claims, next() called', () => {
    const token = signOperatorToken({ id: 'staff-1', role: 'cashier' }, 'tenant-1')
    const req = mockReq(
      { 'x-operator-token': token },
      { id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
    )
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(req.actingStaff).toEqual({ id: 'staff-1', role: 'cashier' })
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('Test 2: no X-Operator-Token header -> req.actingStaff left undefined, next() called', () => {
    const req = mockReq({}, { id: 'user-1', role: 'owner', tenantId: 'tenant-1' })
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(req.actingStaff).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('Test 3: garbage/tampered X-Operator-Token -> 401, next() NOT called', () => {
    const req = mockReq(
      { 'x-operator-token': 'garbage.tampered.token' },
      { id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
    )
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid operator session' })
  })

  it('CR-01 regression: an operator token minted for tenant A is REJECTED (401) when presented alongside a req.user session whose tenantId is tenant B — prevents cross-tenant privilege escalation via token replay', () => {
    const tokenMintedForTenantA = signOperatorToken({ id: 'staff-in-tenant-a', role: 'owner' }, 'tenant-A')
    const req = mockReq(
      { 'x-operator-token': tokenMintedForTenantA },
      { id: 'user-in-tenant-b', role: 'cashier', tenantId: 'tenant-B' },
    )
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(req.actingStaff).toBeUndefined()
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid operator session' })
  })

  it('CR-01 regression: a valid, tenant-matching operator token is still rejected if req.user is missing (operatorContext must run after authMiddleware)', () => {
    const token = signOperatorToken({ id: 'staff-1', role: 'owner' }, 'tenant-1')
    const req = mockReq({ 'x-operator-token': token }, undefined)
    const res = mockRes()
    const next = vi.fn()

    operatorContext(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid operator session' })
  })
})
