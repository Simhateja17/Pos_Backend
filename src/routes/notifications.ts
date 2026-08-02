import { Router } from 'express'
import { forTenant } from '../db/tenantClient'

const router = Router()

function toNotificationJson(row: any) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * GET / — every notification for this tenant, newest first. No pagination:
 * V1's trigger set and small-shop event volume don't justify it yet, and
 * marking-all-read on every open (below) keeps the unread set naturally
 * small regardless of how much history accumulates.
 */
router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const rows = await client.notifications.findMany({ orderBy: { created_at: 'desc' } })
  return res.json({
    notifications: rows.map(toNotificationJson),
    unreadCount: rows.filter((row: any) => row.read_at === null).length,
  })
})

/**
 * POST /read — marks every currently-unread notification read in one call.
 * Matches the read semantics decided for V1: opening the panel clears it,
 * there is no per-item mark-as-read.
 */
router.post('/read', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  await client.notifications.updateMany({
    where: { read_at: null },
    data: { read_at: new Date() },
  })
  return res.status(200).json({ ok: true })
})

export default router
