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

  it('recognises the durable browser register lock', () => {
    const req = { headers: { cookie: 'another=value; couture_register_locked=1' } } as Request
    expect(isRegisterLocked(req)).toBe(true)
  })

  it('uses credentialed cross-origin cookie attributes in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_COOKIE_SAME_SITE', '')
    const res = response()

    setCounterDeviceCookie(res, 'device-token')
    setRegisterLockedCookie(res)

    const headers = vi.mocked(res.append).mock.calls.map((call) => String(call[1]))
    expect(headers).toHaveLength(2)
    for (const header of headers) {
      expect(header).toContain('HttpOnly')
      expect(header).toContain('SameSite=None')
      expect(header).toContain('Secure')
    }
  })
})
