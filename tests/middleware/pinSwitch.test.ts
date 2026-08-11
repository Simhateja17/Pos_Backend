import { describe, it, expect, vi, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'

process.env.SUPABASE_JWT_SECRET = 'test-secret-for-pin-switch-unit-tests'

const findFirstMock = vi.fn()
const updateMock = vi.fn()
const queryRawMock = vi.fn()

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn((tenantId: string) => ({
    staff_members: {
      findFirst: (...args: unknown[]) => findFirstMock(tenantId, ...args),
      update: (...args: unknown[]) => updateMock(tenantId, ...args),
    },
  })),
  forTenantTransaction: vi.fn(async (_tenantId: string, callback: (tx: any) => Promise<unknown>) =>
    callback({
      $queryRaw: queryRawMock,
      staff_members: { update: updateMock },
    }),
  ),
}))

import {
  validatePin,
  signOperatorToken,
  verifyOperatorToken,
} from '../../src/middleware/pinSwitch'

describe('pinSwitch', () => {
  beforeEach(() => {
    findFirstMock.mockReset()
    updateMock.mockReset()
    queryRawMock.mockReset()
  })

  it('Test 1: correct PIN for an active staff member -> ok:true, resets pin_attempts to 0', async () => {
    const hash = await bcrypt.hash('1234', 4)
    queryRawMock.mockResolvedValue([{
      id: 'staff-1',
      role: 'cashier',
      store_id: 'store-1',
      pin_hash: hash,
      pin_attempts: 2,
      pin_locked_until: null,
      pin_must_change: null,
    }])
    updateMock.mockResolvedValue({})

    const result = await validatePin('tenant-1', 'staff-1', '1234')

    expect(result).toEqual({ ok: true, staff: { id: 'staff-1', role: 'cashier', storeId: 'store-1' } })
    const queryText = queryRawMock.mock.calls[0][0].join(' ')
    expect(queryText).toContain('store_id')
    expect(queryText).toContain('FOR UPDATE')
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'staff-1' },
        data: { pin_attempts: 0, pin_locked_until: null },
      }),
    )
  })

  it('Test 2: incorrect PIN increments pin_attempts, locks after the 5th failure, stays locked until timestamp passes', async () => {
    const hash = await bcrypt.hash('1234', 4)
    queryRawMock.mockResolvedValue([{
      id: 'staff-1',
      role: 'cashier',
      store_id: 'store-1',
      pin_hash: hash,
      pin_attempts: 4,
      pin_locked_until: null,
      pin_must_change: null,
    }])
    updateMock.mockResolvedValue({})

    const result = await validatePin('tenant-1', 'staff-1', '9999')

    expect(result).toEqual({ ok: false, reason: 'incorrect' })
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'staff-1' },
        data: expect.objectContaining({ pin_attempts: 5, pin_locked_until: expect.any(Date) }),
      }),
    )

    // Subsequent attempt while locked, even with correct PIN, fails with 'locked'
    queryRawMock.mockResolvedValue([{
      id: 'staff-1',
      role: 'cashier',
      store_id: 'store-1',
      pin_hash: hash,
      pin_attempts: 5,
      pin_locked_until: new Date(Date.now() + 10 * 60 * 1000),
      pin_must_change: null,
    }])

    const lockedResult = await validatePin('tenant-1', 'staff-1', '1234')
    expect(lockedResult).toEqual({ ok: false, reason: 'locked' })
  })

  it('Test 3: a PIN belonging to a staff member in a DIFFERENT tenant never matches — lookup is tenant-scoped', async () => {
    queryRawMock.mockResolvedValue([])

    const result = await validatePin('tenant-2', 'staff-in-tenant-1', '1234')

    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(queryRawMock).toHaveBeenCalled()
  })

  it('Test 4: signOperatorToken/verifyOperatorToken round-trip (with tenant_id binding); tampered token returns null, never throws', () => {
    const token = signOperatorToken({ id: 'staff-1', role: 'manager', storeId: 'store-1' }, 'tenant-1')
    const decoded = verifyOperatorToken(token)
    expect(decoded).toEqual({ id: 'staff-1', role: 'manager', storeId: 'store-1', tenantId: 'tenant-1' })

    expect(() => verifyOperatorToken('garbage.tampered.token')).not.toThrow()
    expect(verifyOperatorToken('garbage.tampered.token')).toBeNull()
  })

  it('Test 5: pin_hash is NULL -> always returns not_found, never calls bcrypt.compare', async () => {
    queryRawMock.mockResolvedValue([{
      id: 'staff-1',
      role: 'cashier',
      store_id: 'store-1',
      pin_hash: null,
      pin_attempts: 0,
      pin_locked_until: null,
      pin_must_change: null,
    }])

    const result = await validatePin('tenant-1', 'staff-1', '1234')

    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(updateMock).not.toHaveBeenCalled()
  })
})
