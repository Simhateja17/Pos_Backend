import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import {
  getCounterDeviceToken,
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

  it('accepts the explicit native device header without browser cookies', () => {
    const token = 'a'.repeat(64)
    const req = { headers: { 'x-counter-device-token': token } } as unknown as Request
    expect(getCounterDeviceToken(req)).toBe(token)
  })

  it('rejects malformed or conflicting device identities', () => {
    const token = 'a'.repeat(64)
    expect(getCounterDeviceToken({ headers: { 'x-counter-device-token': 'not-a-token' } } as unknown as Request)).toBeUndefined()
    expect(getCounterDeviceToken({
      headers: { cookie: `couture_counter_device=${token}`, 'x-counter-device-token': 'b'.repeat(64) },
    } as unknown as Request)).toBeUndefined()
  })
})
