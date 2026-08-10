import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import {
  isRegisterLocked,
  setCounterDeviceCookie,
  setRegisterLockedCookie,
} from '../../src/lib/counterDevice'

function response() {
  return { append: vi.fn() } as unknown as Response
}

describe('counter device cookies', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('recognises a durable browser register lock only for its own tenant', () => {
    const req = { headers: { cookie: 'another=value; couture_register_locked=tenant-a' } } as Request
    expect(isRegisterLocked(req, 'tenant-a')).toBe(true)
    expect(isRegisterLocked(req, 'tenant-b')).toBe(false)
  })

  it('uses credentialed cross-origin cookie attributes in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_COOKIE_SAME_SITE', '')
    const res = response()

    setCounterDeviceCookie(res, 'device-token')
    setRegisterLockedCookie(res, 'tenant-a')

    const headers = vi.mocked(res.append).mock.calls.map((call) => String(call[1]))
    expect(headers).toHaveLength(2)
    for (const header of headers) {
      expect(header).toContain('HttpOnly')
      expect(header).toContain('SameSite=None')
      expect(header).toContain('Secure')
    }
    expect(headers[1]).toContain('couture_register_locked=tenant-a')
  })
})
