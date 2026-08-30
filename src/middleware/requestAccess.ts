import type { Request } from 'express'
import { forTenantTransaction } from '../db/tenantClient'
import {
  accessHeartbeatCutoff,
  accessHeartbeatDue,
  getCounterDeviceToken,
  hashCounterDeviceToken,
} from '../lib/counterDevice'
import { OPEN_SUBSCRIPTION_STATUSES, subscriptionAccessForRow, trialAccessForRow } from '../services/billingAccess'
import { verifyOperatorToken } from './pinSwitch'

type StaffRole = 'owner' | 'manager' | 'cashier'
type RequestAccessContext = NonNullable<Request['accessContext']>

type VerifiedIdentity = {
  userId: string
  tenantId: string
  role: StaffRole
}

type ResolvedRequestAccess = {
  membership: { role: StaffRole; tenant_id: string; store_id: string } | null
  accessContext: RequestAccessContext | null
}

function operatorToken(req: Request): string | undefined {
  const header = req.headers['x-operator-token']
  return Array.isArray(header) ? header[0] : header
}

function validOperatorStaff(
  claims: NonNullable<ReturnType<typeof verifyOperatorToken>>,
  resolvedStoreId?: string,
): Extract<RequestAccessContext['operator'], { state: 'valid' }>['staff'] {
  const staff: Extract<RequestAccessContext['operator'], { state: 'valid' }>['staff'] = {
    id: claims.id,
    role: claims.role,
  }
  if (claims.sessionId) staff.sessionId = claims.sessionId
  const storeId = resolvedStoreId ?? claims.storeId
  if (storeId) staff.storeId = storeId
  if (claims.mustChangePin !== undefined) staff.mustChangePin = claims.mustChangePin
  return staff
}

/**
 * Resolve every database-backed request guard while holding exactly one tenant
 * transaction. Middleware later in the chain only enforces this server-owned
 * snapshot; it does not reacquire a connection for subscription, operator, or
 * paired-terminal checks.
 */
export async function resolveRequestAccess(
  req: Request,
  identity: VerifiedIdentity,
): Promise<ResolvedRequestAccess> {
  const rawOperatorToken = operatorToken(req)
  const claims = rawOperatorToken ? verifyOperatorToken(rawOperatorToken) : null
  const claimsMatchTenant = Boolean(claims && claims.tenantId === identity.tenantId)
  const deviceToken = getCounterDeviceToken(req)
  const now = new Date()
  const heartbeatCutoff = accessHeartbeatCutoff(now)

  return forTenantTransaction(identity.tenantId, async (tx) => {
    const membership = await tx.staff_members.findFirst({
      where: { user_id: identity.userId, role: identity.role, is_active: true },
      // store_id (Phase 8) comes from the membership row, not the JWT claim.
      // The claim is a cache written at token-issue time; moving a staff member
      // to another shop must take effect on their next request, not on their
      // next token refresh.
      select: { role: true, tenant_id: true, store_id: true },
    })

    if (
      !membership ||
      membership.tenant_id !== identity.tenantId ||
      membership.role !== identity.role
    ) {
      return { membership: null, accessContext: null }
    }

    const subscriptionRow = await tx.billing_subscriptions.findFirst({
      where: {
        tenant_id: identity.tenantId,
        status: { in: [...OPEN_SUBSCRIPTION_STATUSES] },
      },
      orderBy: { updated_at: 'desc' },
    })
    let trialRow: any | null = null
    if (!subscriptionRow && typeof tx.$queryRaw === 'function') {
      let trials: any[] = []
      try {
        trials = await tx.$queryRaw<any[]>`
          SELECT * FROM public.billing_trials
          WHERE tenant_id = ${identity.tenantId}::uuid AND status IN ('pending', 'active')
          ORDER BY created_at DESC LIMIT 1
        `
      } catch {
        // A rolling deploy can briefly run before migration 0072. Paid
        // subscription checks remain authoritative until the trial table is available.
      }
      trialRow = trials[0] ?? null
      if (trialRow?.status === 'pending') {
        if (trialRow.latest_activation_at && new Date(trialRow.latest_activation_at).getTime() <= now.getTime()) {
          await tx.$executeRaw`UPDATE public.billing_trials SET status = 'expired', updated_at = now() WHERE id = ${trialRow.id}::uuid AND status = 'pending'`
          trialRow = null
        } else {
          let offerRows: any[] = []
          if (trialRow.private_offer_id) {
            try {
              offerRows = await tx.$queryRaw<any[]>`
                SELECT trial_days, trial_duration_minutes FROM public.private_billing_offers WHERE id = ${trialRow.private_offer_id}::uuid LIMIT 1
              `
            } catch {
              offerRows = []
            }
          }
          const storedMinutes = Number(offerRows[0]?.trial_duration_minutes ?? 0)
          const trialMinutes = Math.max(1, storedMinutes > 0 ? storedMinutes : Number(offerRows[0]?.trial_days ?? 1) * 1440)
          const activated = await tx.$queryRaw<any[]>`
            UPDATE public.billing_trials
            SET status = 'active', started_at = ${now}, activated_at = ${now}, ends_at = ${now} + (${trialMinutes} * interval '1 minute'), updated_at = now()
            WHERE id = ${trialRow.id}::uuid AND status = 'pending'
            RETURNING *
          `
          trialRow = activated[0] ?? trialRow
        }
      }
    }
    const subscription = subscriptionRow ? subscriptionAccessForRow(subscriptionRow, now) : trialAccessForRow(trialRow, now)

    // Grace expiry is the only authorization-path write that must happen
    // immediately. It runs once when the boundary is crossed, not per request.
    if (
      subscriptionRow &&
      subscriptionRow.entitlement_status === 'grace' &&
      !subscription.accessAllowed
    ) {
      await tx.billing_subscriptions.updateMany({
        where: { id: subscriptionRow.id, entitlement_status: 'grace' },
        data: { entitlement_status: 'blocked' },
      })
    }

    const pairedTerminal = deviceToken
      ? await tx.terminals.findFirst({
          where: { device_token_hash: hashCounterDeviceToken(deviceToken), is_active: true },
          select: { id: true, device_last_seen_at: true },
        })
      : null

    if (pairedTerminal && accessHeartbeatDue(pairedTerminal.device_last_seen_at, heartbeatCutoff)) {
      await tx.terminals.updateMany({
        where: {
          id: pairedTerminal.id,
          OR: [
            { device_last_seen_at: null },
            { device_last_seen_at: { lt: heartbeatCutoff } },
          ],
        },
        data: { device_last_seen_at: now },
      })
    }

    let operator: RequestAccessContext['operator']
    if (!rawOperatorToken) {
      operator = { state: 'absent' }
    } else if (!claims || !claimsMatchTenant) {
      operator = { state: 'invalid' }
    } else if (!claims.sessionId) {
      // Backward compatibility for tokens minted before durable staff_sessions
      // were introduced. They remain tenant-bound and signature-verified.
      const operatorStaff = await tx.staff_members.findFirst({
        where: { id: claims.id, role: claims.role, is_active: true },
        select: { id: true, role: true, store_id: true },
      })
      operator = operatorStaff
        ? { state: 'valid', staff: validOperatorStaff(claims, operatorStaff.store_id) }
        : { state: 'invalid' }
    } else {
      const session = await tx.staff_sessions.findFirst({
        where: { id: claims.sessionId, logged_out_at: null },
        include: {
          staff_members: { select: { id: true, role: true, store_id: true, is_active: true } },
        },
      })

      const sessionIsValid = Boolean(
        session &&
          session.staff_members?.is_active &&
          session.staff_members.id === claims.id &&
          session.staff_members.role === claims.role &&
          (session.terminal_id === null || pairedTerminal?.id === session.terminal_id),
      )

      if (!sessionIsValid || !session) {
        operator = { state: 'invalid' }
      } else {
        if (accessHeartbeatDue(session.last_seen_at, heartbeatCutoff)) {
          await tx.staff_sessions.updateMany({
            where: { id: session.id, logged_out_at: null, last_seen_at: { lt: heartbeatCutoff } },
            data: { last_seen_at: now },
          })
        }
        operator = { state: 'valid', staff: validOperatorStaff(claims, session.staff_members.store_id) }
      }
    }

    return {
      membership: {
        role: membership.role as StaffRole,
        tenant_id: membership.tenant_id,
        store_id: membership.store_id,
      },
      accessContext: {
        subscription,
        pairedTerminalId: pairedTerminal?.id ?? null,
        operator,
      },
    }
  })
}
