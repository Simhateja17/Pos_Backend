import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../../src/db/tenantClient', () => ({ forTenant: vi.fn(() => ({})) }))
vi.mock('../../src/lib/counterDevice', () => ({
  findPairedTerminal: vi.fn(),
  isRegisterLocked: vi.fn(() => false),
}))

import { findPairedTerminal, isRegisterLocked } from '../../src/lib/counterDevice'
import { forTenant } from '../../src/db/tenantClient'
import {
  requireOperatorOnPairedDevice,
  requireOperatorOrFirstPinSetup,
} from '../../src/middleware/requireOperatorOnPairedDevice'

function response(): Response {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as Response
}

describe('requireOperatorOnPairedDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isRegisterLocked).mockReturnValue(false)
  })

  it('allows an unpaired owner browser to perform setup', async () => {
    vi.mocked(findPairedTerminal).mockResolvedValue(null)
    const req = { user: { id: 'owner', tenantId: 'tenant', role: 'owner' } } as Request
    const res = response()
    const next = vi.fn()

    await requireOperatorOnPairedDevice(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('keeps an explicitly locked register protected even when its counter pairing is missing', async () => {
    vi.mocked(findPairedTerminal).mockResolvedValue(null)
    vi.mocked(isRegisterLocked).mockReturnValue(true)
    const req = { user: { id: 'owner', tenantId: 'tenant', role: 'owner' } } as Request
    const res = response()
    const next = vi.fn()

    await requireOperatorOnPairedDevice(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(423)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REGISTER_LOCKED' }))
  })

  it('locks a paired browser when no staff PIN session is active', async () => {
    vi.mocked(findPairedTerminal).mockResolvedValue({ id: 'counter-1' } as never)
    const req = { user: { id: 'owner', tenantId: 'tenant', role: 'owner' } } as Request
    const res = response()
    const next = vi.fn()

    await requireOperatorOnPairedDevice(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(423)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REGISTER_LOCKED' }))
  })

  it('uses the PIN-verified acting staff identity on a paired browser', async () => {
    vi.mocked(findPairedTerminal).mockResolvedValue({ id: 'counter-1' } as never)
    const req = {
      user: { id: 'owner', tenantId: 'tenant', role: 'owner' },
      actingStaff: { id: 'cashier', role: 'cashier' },
    } as Request
    const res = response()
    const next = vi.fn()

    await requireOperatorOnPairedDevice(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('allows owner recovery only while no active staff PIN exists', async () => {
    vi.mocked(findPairedTerminal).mockResolvedValue({ id: 'counter-1' } as never)
    vi.mocked(forTenant).mockReturnValue({
      staff_members: { count: vi.fn().mockResolvedValue(0) },
    } as never)
    const req = { user: { id: 'owner', tenantId: 'tenant', role: 'owner' } } as Request
    const res = response()
    const next = vi.fn()

    await requireOperatorOrFirstPinSetup(req, res, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('closes the recovery exception after the first staff PIN is saved', async () => {
    vi.mocked(findPairedTerminal).mockResolvedValue({ id: 'counter-1' } as never)
    vi.mocked(forTenant).mockReturnValue({
      staff_members: { count: vi.fn().mockResolvedValue(1) },
    } as never)
    const req = { user: { id: 'owner', tenantId: 'tenant', role: 'owner' } } as Request
    const res = response()
    const next = vi.fn()

    await requireOperatorOrFirstPinSetup(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(423)
  })
})
