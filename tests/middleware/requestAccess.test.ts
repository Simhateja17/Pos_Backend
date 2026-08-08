import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request } from 'express'

process.env.SUPABASE_JWT_SECRET = 'request-access-test-secret'

const tenantMocks = vi.hoisted(() => ({
  forTenantTransaction: vi.fn(),
}))

vi.mock('../../src/db/tenantClient', () => ({
  forTenantTransaction: tenantMocks.forTenantTransaction,
}))

import { resolveRequestAccess } from '../../src/middleware/requestAccess'
import { signOperatorToken } from '../../src/middleware/pinSwitch'

function requestWith(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

function transaction(overrides: Record<string, any> = {}) {
  return {
    staff_members: {
      findFirst: vi.fn().mockResolvedValue({ role: 'manager', tenant_id: 'tenant-1' }),
    },
    billing_subscriptions: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'subscription-1',
        entitlement_status: 'active',
        grace_until_at: null,
      }),
      updateMany: vi.fn(),
    },
    terminals: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
    },
    staff_sessions: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
    },
    ...overrides,
  }
}

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'manager' as const }

describe('resolveRequestAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves membership, subscription, operator and terminal in one tenant transaction', async () => {
    const tx = transaction()
    tenantMocks.forTenantTransaction.mockImplementationOnce(async (_tenantId, callback) => callback(tx))

    const resolved = await resolveRequestAccess(requestWith(), identity)

    expect(tenantMocks.forTenantTransaction).toHaveBeenCalledOnce()
    expect(tenantMocks.forTenantTransaction).toHaveBeenCalledWith('tenant-1', expect.any(Function))
    expect(resolved.membership).toEqual({ role: 'manager', tenant_id: 'tenant-1' })
    expect(resolved.accessContext).toEqual({
      subscription: { entitlement: 'active', accessAllowed: true, graceUntil: null },
      pairedTerminalId: null,
      operator: { state: 'absent' },
    })
  })

  it('validates a durable operator session and refreshes stale heartbeats once', async () => {
    const stale = new Date(Date.now() - 5 * 60_000)
    const terminalUpdateMany = vi.fn()
    const sessionUpdateMany = vi.fn()
    const tx = transaction({
      terminals: {
        findFirst: vi.fn().mockResolvedValue({ id: 'terminal-1', device_last_seen_at: stale }),
        updateMany: terminalUpdateMany,
      },
      staff_sessions: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          terminal_id: 'terminal-1',
          last_seen_at: stale,
          staff_members: { id: 'staff-1', role: 'cashier', is_active: true },
        }),
        updateMany: sessionUpdateMany,
      },
    })
    tenantMocks.forTenantTransaction.mockImplementationOnce(async (_tenantId, callback) => callback(tx))
    const token = signOperatorToken(
      { id: 'staff-1', role: 'cashier', sessionId: 'session-1' },
      'tenant-1',
    )

    const resolved = await resolveRequestAccess(
      requestWith({
        'x-operator-token': token,
        cookie: 'couture_counter_device=device-token',
      }),
      identity,
    )

    expect(resolved.accessContext?.pairedTerminalId).toBe('terminal-1')
    expect(resolved.accessContext?.operator).toEqual({
      state: 'valid',
      staff: { id: 'staff-1', role: 'cashier', sessionId: 'session-1' },
    })
    expect(terminalUpdateMany).toHaveBeenCalledOnce()
    expect(sessionUpdateMany).toHaveBeenCalledOnce()
  })

  it('does not write heartbeats that are still inside the configured interval', async () => {
    const recent = new Date()
    const terminalUpdateMany = vi.fn()
    const sessionUpdateMany = vi.fn()
    const tx = transaction({
      terminals: {
        findFirst: vi.fn().mockResolvedValue({ id: 'terminal-1', device_last_seen_at: recent }),
        updateMany: terminalUpdateMany,
      },
      staff_sessions: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          terminal_id: 'terminal-1',
          last_seen_at: recent,
          staff_members: { id: 'staff-1', role: 'cashier', is_active: true },
        }),
        updateMany: sessionUpdateMany,
      },
    })
    tenantMocks.forTenantTransaction.mockImplementationOnce(async (_tenantId, callback) => callback(tx))
    const token = signOperatorToken(
      { id: 'staff-1', role: 'cashier', sessionId: 'session-1' },
      'tenant-1',
    )

    await resolveRequestAccess(
      requestWith({
        'x-operator-token': token,
        cookie: 'couture_counter_device=device-token',
      }),
      identity,
    )

    expect(terminalUpdateMany).not.toHaveBeenCalled()
    expect(sessionUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects a durable operator session bound to a different terminal', async () => {
    const tx = transaction({
      terminals: {
        findFirst: vi.fn().mockResolvedValue({ id: 'terminal-2', device_last_seen_at: new Date() }),
        updateMany: vi.fn(),
      },
      staff_sessions: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'session-1',
          terminal_id: 'terminal-1',
          last_seen_at: new Date(),
          staff_members: { id: 'staff-1', role: 'cashier', is_active: true },
        }),
        updateMany: vi.fn(),
      },
    })
    tenantMocks.forTenantTransaction.mockImplementationOnce(async (_tenantId, callback) => callback(tx))
    const token = signOperatorToken(
      { id: 'staff-1', role: 'cashier', sessionId: 'session-1' },
      'tenant-1',
    )

    const resolved = await resolveRequestAccess(
      requestWith({
        'x-operator-token': token,
        cookie: 'couture_counter_device=device-token',
      }),
      identity,
    )

    expect(resolved.accessContext?.operator).toEqual({ state: 'invalid' })
    expect(tx.staff_sessions.updateMany).not.toHaveBeenCalled()
  })
})
