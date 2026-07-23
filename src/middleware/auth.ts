import type { NextFunction, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_ANON_KEY as string,
)

/**
 * Decodes the (already-verified-by-Supabase) JWT payload to read the custom
 * `role`/`tenant_id` claims written by the Custom Access Token Hook
 * (01-RESEARCH.md Pattern 2). Supabase's Custom Access Token Hook writes
 * these as TOP-LEVEL claims, not nested under app_metadata/user_metadata,
 * so a base64 decode of the payload segment is required — `getUser()`'s
 * return value does not expose them directly.
 *
 * This does NOT re-verify the signature — `supabase.auth.getUser(token)`
 * (called before this in authMiddleware) is the actual verification step.
 * This function only extracts already-trusted claims for local use.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split('.')
  if (segments.length !== 3) {
    throw new Error('Malformed JWT')
  }
  const json = Buffer.from(segments[1], 'base64url').toString('utf8')
  return JSON.parse(json)
}

/**
 * Verifies the Supabase-issued JWT from the Authorization header and derives
 * req.user = { id, role, tenantId } strictly from verified JWT claims.
 *
 * SECURITY (T-1-01): role and tenantId are NEVER read from req.body,
 * req.params, or req.query anywhere in this file — only from the decoded,
 * server-verified JWT claims. A client cannot influence its own tenant/role
 * identity by supplying conflicting fields elsewhere in the request.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = header.slice('Bearer '.length).trim()
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let claims: Record<string, unknown>
  try {
    claims = decodeJwtPayload(token)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const role = claims.role as ('owner' | 'manager' | 'cashier' | undefined)
  const tenantId = claims.tenant_id as (string | undefined)

  if (!role || !tenantId) {
    return res.status(403).json({ error: 'No tenant membership found' })
  }

  req.user = { id: data.user.id, role, tenantId }
  next()
}
