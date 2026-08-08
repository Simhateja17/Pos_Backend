import { beforeEach, describe, expect, it } from 'vitest'
import { consumeRateLimit, resetRateLimits } from '../../src/lib/rateLimit'

describe('consumeRateLimit', () => {
  beforeEach(() => resetRateLimits())

  it('allows the configured number of requests and rejects the next one', () => {
    expect(consumeRateLimit('key', 2, 60_000, 1_000).allowed).toBe(true)
    expect(consumeRateLimit('key', 2, 60_000, 1_001).allowed).toBe(true)
    expect(consumeRateLimit('key', 2, 60_000, 1_002)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    })
  })

  it('starts a new window after expiry', () => {
    expect(consumeRateLimit('key', 1, 1_000, 1_000).allowed).toBe(true)
    expect(consumeRateLimit('key', 1, 1_000, 1_999).allowed).toBe(false)
    expect(consumeRateLimit('key', 1, 1_000, 2_000).allowed).toBe(true)
  })
})
