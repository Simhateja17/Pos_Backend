import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { requireRole, ROLE_RANK } from '../../src/middleware/requireRole'

function mockReq(overrides: Partial<Request> = {}): Request {
  return overrides as Request
}

function mockRes(): Response {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as Response
}

describe('requireRole', () => {
  it('Test 1: req.user.role = manager, no actingStaff, requireRole(manager) -> next()', () => {
    const req = mockReq({ user: { id: 'u1', role: 'manager', tenantId: 't1' } })
    const res = mockRes()
    const next = vi.fn()

    requireRole('manager')(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('Test 2: req.user.role = owner but actingStaff = cashier, requireRole(manager) -> 403', () => {
    const req = mockReq({
      user: { id: 'u1', role: 'owner', tenantId: 't1' },
      actingStaff: { id: 's1', role: 'cashier' },
    })
    const res = mockRes()
    const next = vi.fn()

    requireRole('manager')(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' })
  })

  it('Test 3a: req.user.role = owner, no actingStaff, requireRole(owner) -> next()', () => {
    const req = mockReq({ user: { id: 'u1', role: 'owner', tenantId: 't1' } })
    const res = mockRes()
    const next = vi.fn()

    requireRole('owner')(req, res, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('Test 3b: actingStaff = manager, requireRole(owner) -> 403', () => {
    const req = mockReq({
      user: { id: 'u1', role: 'owner', tenantId: 't1' },
      actingStaff: { id: 's1', role: 'manager' },
    })
    const res = mockRes()
    const next = vi.fn()

    requireRole('owner')(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('ROLE_RANK reflects owner >= manager >= cashier ordering', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.manager)
    expect(ROLE_RANK.manager).toBeGreaterThan(ROLE_RANK.cashier)
  })

  it('defends against misordered middleware: neither req.user nor req.actingStaff set -> 401', () => {
    const req = mockReq({})
    const res = mockRes()
    const next = vi.fn()

    requireRole('cashier')(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
