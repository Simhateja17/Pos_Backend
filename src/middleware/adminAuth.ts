import type { NextFunction, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { decodeJwtPayload } from './auth'
import {
  adminPanelEnabled,
  backendAdminRegion,
  findPlatformAdminByUserId,
  insertAuditEvent,
  type PlatformAdmin,
} from '../services/adminStore'

export type AdminAuthOptions = {
  /** Allow the post-OTP aal1 session for MFA setup/context only. */
  requireAal2?: boolean
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || null : null
}

function expectedIssuer(): string | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '')
  return url ? `${url}/auth/v1` : null
}

function regionOriginAllowed(req: Request, region: 'IN' | 'INTL'): boolean {
  // Same-origin production requests have no Origin header on some browsers.
  // When one is present, it is an additional regional routing assertion. Local
  // development is explicitly allowed for either configured regional project.
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true
    if (region === 'IN') return hostname === 'in.ambelpos.com'
    return hostname === 'www.ambelpos.com' || hostname === 'ambelpos.com'
  } catch {
    return false
  }
}

function isAal2(claims: Record<string, unknown>): boolean {
  if (claims.aal === 'aal2') return true
  const amr = claims.amr
  return Array.isArray(amr) && amr.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    return (entry as { method?: unknown }).method === 'totp' || (entry as { method?: unknown }).method === 'mfa/totp'
  })
}

function authTimeIsFresh(claims: Record<string, unknown>, maxAgeSeconds = 300): boolean {
  const amr = Array.isArray(claims.amr) ? claims.amr : []
  const totpTimes = amr
    .filter((entry): entry is { method?: unknown; timestamp?: unknown } => Boolean(entry && typeof entry === 'object'))
    .filter((entry) => entry.method === 'totp' || entry.method === 'mfa/totp')
    .map((entry) => Number(entry.timestamp))
    .filter((value) => Number.isFinite(value))
  const value = totpTimes.length > 0
    ? Math.max(...totpTimes)
    : typeof claims.auth_time === 'number' ? claims.auth_time : Number(claims.auth_time)
  if (!Number.isFinite(value)) return false
  const age = Math.floor(Date.now() / 1000) - value
  return age >= 0 && age <= maxAgeSeconds
}

async function recordAuthorizationDenial(req: Request, reason: string) {
  if (!req.admin) return
  await insertAuditEvent({
    administratorId: req.admin.id,
    action: 'admin.authorization.denied',
    targetType: 'route',
    targetId: `${req.method} ${req.originalUrl}`.slice(0, 500),
    reason,
    requestId: req.get('x-request-id')?.slice(0, 200) ?? null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent')?.slice(0, 1_000) ?? null,
  }).catch((error) => console.error('[admin-auth] failed to record authorization denial', error))
}

/**
 * Separate platform-admin authentication boundary. It never reads merchant
 * tenant/role claims and never invokes merchant membership or PIN middleware.
 */
export function adminAuthMiddleware(options: AdminAuthOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!adminPanelEnabled()) return res.status(404).json({ error: 'Admin Panel is disabled' })

    let region: 'IN' | 'INTL'
    try {
      region = backendAdminRegion()
    } catch {
      return res.status(503).json({ error: 'Admin Panel is not configured for this region' })
    }

    if (!regionOriginAllowed(req, region)) {
      return res.status(403).json({ error: 'Wrong regional Admin Panel host' })
    }

    const token = bearerToken(req)
    if (!token) return res.status(401).json({ error: 'Admin authentication required' })

    let claims: Record<string, unknown>
    try {
      claims = decodeJwtPayload(token)
    } catch {
      return res.status(401).json({ error: 'Invalid admin session' })
    }

    const issuer = expectedIssuer()
    if (issuer && claims.iss !== issuer) return res.status(403).json({ error: 'Wrong regional admin issuer' })
    if (claims.aud !== undefined && claims.aud !== 'authenticated') return res.status(401).json({ error: 'Invalid admin audience' })
    const exp = Number(claims.exp)
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return res.status(401).json({ error: 'Admin session expired' })

    const supabaseUrl = process.env.SUPABASE_URL?.trim()
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim()
    if (!supabaseUrl || !supabaseAnonKey) return res.status(503).json({ error: 'Admin authentication is not configured' })

    const verifier = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await verifier.auth.getUser(token)
    if (error || !data.user) return res.status(401).json({ error: 'Invalid admin session' })
    if (claims.sub !== undefined && claims.sub !== data.user.id) return res.status(401).json({ error: 'Invalid admin subject' })

    let admin: PlatformAdmin | null
    try {
      admin = await findPlatformAdminByUserId(data.user.id)
    } catch (storeError) {
      console.error('[admin-auth] admin lookup failed', storeError)
      return res.status(503).json({ error: 'Admin authentication is temporarily unavailable' })
    }

    if (!admin || admin.auth_user_id !== data.user.id) return res.status(403).json({ error: 'This account is not an Ambel administrator' })
    if (admin.region !== region) return res.status(403).json({ error: 'Administrator belongs to another region' })
    if (admin.status === 'suspended') return res.status(403).json({ error: 'Administrator account is suspended' })
    if (admin.status !== 'active' && admin.status !== 'invited') return res.status(403).json({ error: 'Administrator account is not active' })

    const aal2 = isAal2(claims)
    if (options.requireAal2 !== false && !aal2) {
      req.admin = {
        id: admin.id,
        authUserId: admin.auth_user_id,
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role,
        region: admin.region,
        status: admin.status,
        aal: 'aal1',
        authTime: Number(claims.auth_time),
        token,
        claims,
      }
      await recordAuthorizationDenial(req, 'Authenticator verification required')
      return res.status(403).json({ error: 'Authenticator verification required', code: 'mfa_required' })
    }

    req.admin = {
      id: admin.id,
      authUserId: admin.auth_user_id,
      email: admin.email,
      displayName: admin.display_name,
      role: admin.role,
      region: admin.region,
      status: admin.status,
      aal: aal2 ? 'aal2' : 'aal1',
      authTime: Number(claims.auth_time),
      token,
      claims,
    }
    next()
  }
}

export const requireAdminAal2 = adminAuthMiddleware({ requireAal2: true })
export const allowAdminAal1 = adminAuthMiddleware({ requireAal2: false })

export function requireAdminRole(...roles: Array<'platform_owner' | 'support_admin' | 'read_only'>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.admin) return res.status(401).json({ error: 'Admin authentication required' })
    if (!roles.includes(req.admin.role)) {
      await recordAuthorizationDenial(req, `Required role: ${roles.join(', ')}`)
      return res.status(403).json({ error: 'Insufficient Admin Panel permissions' })
    }
    next()
  }
}

/** A fresh TOTP step-up is required for account recovery/destructive admin actions. */
export function requireFreshAdminStepUp(req: Request, res: Response, next: NextFunction) {
  if (!req.admin || req.admin.aal !== 'aal2') {
    void recordAuthorizationDenial(req, 'Fresh authenticator verification required')
    return res.status(403).json({ error: 'Fresh authenticator verification required', code: 'mfa_required' })
  }
  if (!authTimeIsFresh(req.admin.claims)) {
    void recordAuthorizationDenial(req, 'Recent authenticator step-up required')
    return res.status(403).json({ error: 'Re-authenticate with your authenticator before continuing', code: 'step_up_required' })
  }
  next()
}
