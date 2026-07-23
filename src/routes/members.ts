import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { InviteMemberSchema, UpdateMemberRoleSchema } from '../contracts/schemas/member'
import { requireRole } from '../middleware/requireRole'
import { forTenant } from '../db/tenantClient'

const router = Router()

// ADMIN client — service-role key, confined to exactly this file (alongside
// routes/auth.ts's own admin client instance), used ONLY for
// auth.admin.inviteUserByEmail/deleteUser. Never used for any Postgres write
// — tenant-scoped writes always go through forTenant() (T-1-05).
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

type StaffRow = {
  id: string
  name: string
  role: string
  is_active: boolean
  created_at: Date
}

// Maps snake_case DB fields to the camelCase MemberSchema response shape,
// per this plan's <naming_convention>.
function toMemberJson(row: StaffRow) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * GET / — list the caller's tenant's staff roster (D-04). Manager+ view;
 * cashiers see only their own shift activity per D-15, not the org roster.
 * Tenant scoping comes exclusively from req.user.tenantId (verified JWT) —
 * never from req.params/req.body.
 */
router.get('/', requireRole('manager'), async (req, res) => {
  const rows = await (forTenant(req.user!.tenantId) as any).staff_members.findMany({
    orderBy: { created_at: 'asc' },
  })
  res.json(rows.map(toMemberJson))
})

/**
 * POST /invite — invite a new staff member (D-04). Owner-only: granting
 * access to the business itself is an owner-level trust decision (D-04
 * doesn't specify which tier can invite vs. only view — this plan's
 * decision, per 01-08-PLAN.md's code-comment instruction).
 *
 * SECURITY (T-1-10): staff_members.user_id is sourced EXCLUSIVELY from
 * Supabase's own inviteUserByEmail response (server-side Admin API call,
 * service-role key) — never from client-supplied input. inviteUserByEmail
 * creates the (unconfirmed) auth user and returns its id immediately, at
 * invite-send time, not after the invitee accepts — this is what lets
 * custom_access_token_hook resolve role/tenant_id on the invited member's
 * very first token.
 */
router.post('/invite', requireRole('owner'), async (req, res) => {
  const parsed = InviteMemberSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const { email, name, role } = parsed.data
  const tenantId = req.user!.tenantId

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: process.env.INVITE_REDIRECT_URL,
  })

  if (error || !data?.user) {
    const status = (error as { status?: number } | null)?.status === 422 ? 409 : 500
    return res.status(status).json({ error: 'Could not send invite' })
  }

  try {
    const staff = await (forTenant(tenantId) as any).staff_members.create({
      data: {
        tenant_id: tenantId,
        user_id: data.user.id,
        name,
        role,
        is_active: true,
      },
    })
    return res.status(201).json(toMemberJson(staff))
  } catch {
    // Partial-failure cleanup: an orphaned invited-but-unlinked auth user is
    // worse than a failed invite — best-effort delete, same pattern as
    // routes/auth.ts's signup orphan cleanup.
    try {
      await supabaseAdmin.auth.admin.deleteUser(data.user.id)
    } catch {
      // best-effort only
    }
    return res.status(500).json({ error: 'Could not create staff record' })
  }
})

/**
 * PATCH /:memberId/role — change a staff member's role. Owner-only; a
 * manager cannot self-promote to owner.
 *
 * SECURITY (T-1-01/T-1-04): :memberId identifies WHICH row, but
 * forTenant(req.user.tenantId) still scopes the query to the caller's own
 * tenant — a memberId from another tenant simply 404s, never leaked/modified.
 */
router.patch('/:memberId/role', requireRole('owner'), async (req, res) => {
  const parsed = UpdateMemberRoleSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const client = forTenant(req.user!.tenantId) as any

  try {
    const target = await client.staff_members.findFirst({
      where: { id: req.params.memberId },
    })
    if (!target) {
      return res.status(404).json({ error: 'Member not found' })
    }

    // WR-04: demoting the tenant's only remaining active owner would
    // permanently lock the tenant out of every owner-gated action (further
    // invites, role changes, deactivations), with no self-service recovery.
    const isDemotingOwner =
      target.role === 'owner' && target.is_active && parsed.data.role !== 'owner'
    if (isDemotingOwner) {
      const activeOwners = await client.staff_members.count({
        where: { role: 'owner', is_active: true },
      })
      if (activeOwners <= 1) {
        return res.status(409).json({ error: 'Cannot remove the last owner' })
      }
    }

    const staff = await client.staff_members.update({
      where: { id: req.params.memberId },
      data: { role: parsed.data.role },
    })
    return res.status(200).json(toMemberJson(staff))
  } catch {
    return res.status(404).json({ error: 'Member not found' })
  }
})

/**
 * DELETE /:memberId — soft-delete (deactivate) a staff member. Owner-only.
 * Never hard-deletes — preserves historical attribution for future
 * sales/shift records per CLAUDE.md's append-only/attribution discipline.
 */
router.delete('/:memberId', requireRole('owner'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any

  try {
    const target = await client.staff_members.findFirst({
      where: { id: req.params.memberId },
    })
    if (!target) {
      return res.status(404).json({ error: 'Member not found' })
    }

    // WR-04: deactivating the tenant's only remaining active owner would
    // permanently lock the tenant out of every owner-gated action, with no
    // self-service recovery — same safeguard as the role-change endpoint.
    if (target.role === 'owner' && target.is_active) {
      const activeOwners = await client.staff_members.count({
        where: { role: 'owner', is_active: true },
      })
      if (activeOwners <= 1) {
        return res.status(409).json({ error: 'Cannot remove the last owner' })
      }
    }

    const staff = await client.staff_members.update({
      where: { id: req.params.memberId },
      data: { is_active: false },
    })
    return res.status(200).json(toMemberJson(staff))
  } catch {
    return res.status(404).json({ error: 'Member not found' })
  }
})

export default router
