import { Router, type Request, type Response } from 'express'
import { forTenantTransaction } from '../db/tenantClient'
import { authMiddleware } from '../middleware/auth'
import { requireRole } from '../middleware/requireRole'
import { insertAuditEvent } from '../services/adminStore'

const router = Router()

type SupportRequestRow = {
  id: string
  tenant_id: string
  merchant_owner_id: string
  ticket_id: string
  reason: string
  status: string
  approved_at: Date | null
  expires_at: Date | null
  terminated_at: Date | null
  created_at: Date
}

function jsonRequest(row: SupportRequestRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    reason: row.reason,
    status: row.status,
    approvedAt: row.approved_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    terminatedAt: row.terminated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * Merchant consent surface.  It is intentionally mounted outside the Admin
 * router: the merchant's normal Supabase session proves who can approve, and
 * no merchant JWT is ever minted for a support administrator.
 */
router.use(authMiddleware)
router.use(requireRole('owner'))

router.get('/access-requests', async (req, res) => {
  const rows = await forTenantTransaction<SupportRequestRow[]>(req.user!.tenantId, async (tx: any) => {
    // Expiry is a state transition, not a read-time lie.  Update old approved
    // requests before returning the list so a stale tab cannot approve/start
    // one that has already elapsed.
    await tx.$executeRaw`
      update public.support_access_requests
      set status = 'expired', session_token_hash = null, updated_at = now()
      where tenant_id = ${req.user!.tenantId}::uuid
        and status = 'approved'
        and expires_at <= now()
    `
    return tx.$queryRaw<SupportRequestRow[]>`
      select id, tenant_id, merchant_owner_id, ticket_id, reason, status,
             approved_at, expires_at, terminated_at, created_at
      from public.support_access_requests
      where tenant_id = ${req.user!.tenantId}::uuid
        and merchant_owner_id in (
          select id from public.staff_members
          where user_id = ${req.user!.id}::uuid and role = 'owner' and is_active = true
        )
      order by created_at desc
      limit 50
    `
  })
  return res.json({ requests: rows.map(jsonRequest) })
})

async function decide(req: Request, res: Response, decision: 'approve' | 'deny') {
  const requestId = req.params.requestId as string
  const result = await forTenantTransaction<{ row: SupportRequestRow | null; ownerName: string | null }>(req.user!.tenantId, async (tx: any) => {
    const rows = await tx.$queryRaw<Array<SupportRequestRow & { owner_name: string; owner_user_id: string }>>`
      select sar.id, sar.tenant_id, sar.merchant_owner_id, sar.ticket_id, sar.reason,
             sar.status, sar.approved_at, sar.expires_at, sar.terminated_at, sar.created_at,
             sm.name as owner_name, sm.user_id as owner_user_id
      from public.support_access_requests sar
      join public.staff_members sm on sm.id = sar.merchant_owner_id
      where sar.id = ${requestId}::uuid
        and sar.tenant_id = ${req.user!.tenantId}::uuid
        and sm.user_id = ${req.user!.id}::uuid
        and sm.role = 'owner' and sm.is_active = true
      for update
    `
    const row = rows[0]
    if (!row) return { row: null, ownerName: null }
    if (row.status !== 'requested') return { row: row as SupportRequestRow, ownerName: row.owner_name }

    const now = new Date()
    const expires = new Date(now.getTime() + 30 * 60 * 1_000)
    if (decision === 'approve') {
      await tx.$executeRaw`
        update public.support_access_requests
        set status = 'approved', approved_at = ${now}, expires_at = ${expires},
            terminated_at = null, terminated_by = null, updated_at = now()
        where id = ${requestId}::uuid and tenant_id = ${req.user!.tenantId}::uuid and status = 'requested'
      `
      await tx.notifications.create({
        data: {
          tenant_id: req.user!.tenantId,
          type: 'support_access_request',
          title: 'Support access approved',
          body: `Support can view this account until ${expires.toISOString()}.`,
          link: '/app/settings',
          metadata: { supportRequestId: requestId, expiresAt: expires.toISOString() },
        },
      })
    } else {
      await tx.$executeRaw`
        update public.support_access_requests
        set status = 'denied', updated_at = now()
        where id = ${requestId}::uuid and tenant_id = ${req.user!.tenantId}::uuid and status = 'requested'
      `
    }
    const updated = { ...row, status: decision === 'approve' ? 'approved' : 'denied', approved_at: decision === 'approve' ? now : null, expires_at: decision === 'approve' ? expires : null }
    return { row: updated as SupportRequestRow, ownerName: row.owner_name }
  })

  if (!result.row) return res.status(404).json({ error: 'Support request not found' })
  if (result.row.status !== (decision === 'approve' ? 'approved' : 'denied')) return res.status(409).json({ error: 'Support request has already been decided' })
  await insertAuditEvent({
    action: `merchant.support_request.${decision === 'approve' ? 'approved' : 'denied'}`,
    tenantId: req.user!.tenantId,
    targetType: 'support_access_request',
    targetId: requestId,
    ticketId: result.row.ticket_id,
    reason: result.row.reason,
    ipAddress: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 1_000) ?? null,
  })
  return res.json({ request: jsonRequest(result.row) })
}

router.post('/access-requests/:requestId/approve', async (req, res) => decide(req, res, 'approve'))
router.post('/access-requests/:requestId/deny', async (req, res) => decide(req, res, 'deny'))

router.post('/access-requests/:requestId/terminate', async (req, res) => {
  const result = await forTenantTransaction<SupportRequestRow | null>(req.user!.tenantId, async (tx: any) => {
    const rows = await tx.$queryRaw<SupportRequestRow[]>`
      select sar.id, sar.tenant_id, sar.merchant_owner_id, sar.ticket_id, sar.reason,
             sar.status, sar.approved_at, sar.expires_at, sar.terminated_at, sar.created_at
      from public.support_access_requests sar
      join public.staff_members sm on sm.id = sar.merchant_owner_id
      where sar.id = ${req.params.requestId}::uuid
        and sar.tenant_id = ${req.user!.tenantId}::uuid
        and sm.user_id = ${req.user!.id}::uuid and sm.role = 'owner' and sm.is_active = true
      for update
    `
    const row = rows[0]
    if (!row) return null
    if (row.status !== 'approved') return row
    await tx.$executeRaw`
      update public.support_access_requests
      set status = 'terminated', terminated_at = now(), session_token_hash = null, updated_at = now()
      where id = ${req.params.requestId}::uuid and tenant_id = ${req.user!.tenantId}::uuid and status = 'approved'
    `
    return { ...row, status: 'terminated', terminated_at: new Date() }
  })
  if (!result) return res.status(404).json({ error: 'Support request not found' })
  if (result.status !== 'terminated') return res.status(409).json({ error: 'Support session is not active' })
  await insertAuditEvent({ action: 'merchant.support_session.terminated', tenantId: req.user!.tenantId, targetType: 'support_access_request', targetId: req.params.requestId, ipAddress: req.ip, userAgent: req.get('user-agent')?.slice(0, 1_000) ?? null })
  return res.json({ request: jsonRequest(result) })
})

export default router
