import type { NextFunction, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { getAuthCookies, setAuthCookies } from '../lib/authCookies'
import { resolveRequestAccess } from './requestAccess'

// supabase-js 2.110 initialises a Realtime client even though this API only
// uses Auth's `getUser()`. Node 20 has no native WebSocket, so provide the
// server-compatible implementation before constructing the Supabase client.
// This keeps the API usable until the local runtime moves to Node 22.
const runtimeGlobal = globalThis as Omit<typeof globalThis, 'WebSocket'> & { WebSocket?: unknown }
runtimeGlobal.WebSocket ??= WebSocket

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_ANON_KEY as string,
)

/**
 * Decodes the (already-verified-by-Supabase) JWT payload to read the custom
 * `staff_role`/`tenant_id` claims written by the Custom Access Token Hook
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

export type StaffRole = 'owner' | 'manager' | 'cashier'

const STAFF_ROLES = new Set<StaffRole>(['owner', 'manager', 'cashier'])

/**
 * Reads Couture's application role without repurposing Supabase's reserved
 * `role` claim. New tokens use `staff_role`; the `role` fallback keeps tokens
 * minted by the previous hook valid until they naturally refresh.
 */
export function getStaffRoleClaim(claims: Record<string, unknown>): StaffRole | undefined {
  const staffRole = claims.staff_role
  if (typeof staffRole === 'string' && STAFF_ROLES.has(staffRole as StaffRole)) {
    return staffRole as StaffRole
  }

  const legacyRole = claims.role
  if (typeof legacyRole === 'string' && STAFF_ROLES.has(legacyRole as StaffRole)) {
    return legacyRole as StaffRole
  }

  return undefined
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
  const cookies = getAuthCookies(req)
  const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
  let token = bearerToken ?? cookies.accessToken

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let { data, error } = await supabase.auth.getUser(token)
  if ((error || !data?.user) && !bearerToken && cookies.refreshToken) {
    const refreshed = await supabase.auth.setSession({ access_token: token, refresh_token: cookies.refreshToken })
    if (refreshed.data.session) {
      token = refreshed.data.session.access_token
      setAuthCookies(res, token, refreshed.data.session.refresh_token)
      data = await supabase.auth.getUser(token).then((result) => result.data)
      error = null
    }
  }
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let claims: Record<string, unknown>
  try {
    claims = decodeJwtPayload(token)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const claimedRole = getStaffRoleClaim(claims)
  const tenantId = typeof claims.tenant_id === 'string' ? claims.tenant_id : undefined

  if (!claimedRole || !tenantId) {
    return res.status(403).json({ error: 'No tenant membership found' })
  }

  // JWT claims are a cache of membership state, not the authority itself.
  // Membership, subscription, operator-session, and paired-device facts are
  // resolved together so an authenticated request acquires one authorization
  // transaction instead of several independent transactions.
  const resolved = await resolveRequestAccess(req, {
    userId: data.user.id,
    tenantId,
    role: claimedRole,
  })

  if (!resolved.membership || !resolved.accessContext) {
    return res.status(403).json({ error: 'No tenant membership found' })
  }

  req.user = { id: data.user.id, role: resolved.membership.role, tenantId }
  req.accessContext = resolved.accessContext
  next()
}
