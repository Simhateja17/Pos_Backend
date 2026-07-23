import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { forTenant } from '../db/tenantClient'

type StaffRole = 'owner' | 'manager' | 'cashier'

export interface OperatorClaims {
  id: string
  role: StaffRole
}

export type ValidatePinResult =
  | { ok: true; staff: OperatorClaims }
  | { ok: false; reason: 'not_found' | 'locked' | 'incorrect' }

const LOCKOUT_THRESHOLD = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 minutes — implementation default (CONTEXT.md discretion)
const OPERATOR_TOKEN_EXPIRY = '8h' // matches a typical shift length

/**
 * validatePin — tenant-scoped PIN validation with server-side brute-force
 * lockout (T-1-02) and tenant isolation (T-1-01).
 *
 * Never bypasses tenant scoping: the staff lookup always goes through
 * forTenant(tenantId), so a correct PIN for a staff member in a different
 * tenant can never match — the row simply won't be found.
 *
 * SECURITY (T-1-09): a NULL pin_hash (not yet provisioned via
 * POST /auth/set-pin, plan 01-13) is treated identically to "not found" and
 * short-circuits BEFORE any bcrypt.compare call — this also means the
 * generic 'incorrect' error copy at the route layer can't be used to
 * distinguish "PIN never set" from "wrong PIN" (route maps both to the same
 * message).
 */
export async function validatePin(
  tenantId: string,
  staffId: string,
  pin: string,
): Promise<ValidatePinResult> {
  const client = forTenant(tenantId)
  const staff = await (client as any).staff_members.findFirst({
    where: { id: staffId, is_active: true },
  })

  if (!staff || !staff.pin_hash) {
    return { ok: false, reason: 'not_found' }
  }

  if (staff.pin_locked_until && new Date(staff.pin_locked_until).getTime() > Date.now()) {
    return { ok: false, reason: 'locked' }
  }

  const matches = await bcrypt.compare(pin, staff.pin_hash)

  if (!matches) {
    const nextAttempts = (staff.pin_attempts ?? 0) + 1
    const data: { pin_attempts: number; pin_locked_until?: Date } = { pin_attempts: nextAttempts }
    if (nextAttempts >= LOCKOUT_THRESHOLD) {
      data.pin_locked_until = new Date(Date.now() + LOCKOUT_DURATION_MS)
    }
    await (client as any).staff_members.update({
      where: { id: staffId },
      data,
    })
    return { ok: false, reason: 'incorrect' }
  }

  await (client as any).staff_members.update({
    where: { id: staffId },
    data: { pin_attempts: 0, pin_locked_until: null },
  })

  return { ok: true, staff: { id: staff.id, role: staff.role as StaffRole } }
}

/**
 * signOperatorToken / verifyOperatorToken — the short-lived, server-signed
 * "active operator" token (01-RESEARCH.md Open Question #1 recommendation).
 * Reuses SUPABASE_JWT_SECRET as the HMAC signing secret (a separate secret
 * scoped only to this app's own signing, distinct from Supabase's own JWT
 * verification path).
 *
 * verifyOperatorToken NEVER throws — callers (operatorContext middleware)
 * rely on a strict never-throw, return-null-on-failure contract so a
 * tampered/expired/malformed token can never be mistaken for a thrown
 * exception that accidentally propagates trust.
 */
export function signOperatorToken(staff: OperatorClaims): string {
  return jwt.sign({ id: staff.id, role: staff.role }, process.env.SUPABASE_JWT_SECRET as string, {
    expiresIn: OPERATOR_TOKEN_EXPIRY,
  })
}

export function verifyOperatorToken(token: string): OperatorClaims | null {
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET as string) as jwt.JwtPayload
    if (!decoded || typeof decoded.id !== 'string' || typeof decoded.role !== 'string') {
      return null
    }
    return { id: decoded.id, role: decoded.role as StaffRole }
  } catch {
    return null
  }
}
