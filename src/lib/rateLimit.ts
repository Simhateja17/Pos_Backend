type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

/**
 * Small process-local limiter for abuse-sensitive actions. It is deliberately
 * kept dependency-free; the database/provider quota remains the durable backstop
 * and this closes the fast parallel-request path at the API boundary.
 */
export function consumeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const current = buckets.get(key)
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    }
  }

  current.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

export function resetRateLimits() {
  buckets.clear()
}
