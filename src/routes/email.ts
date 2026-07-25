import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  CreateSuppressionSchema,
  DeliveryEventSchema,
} from '../contracts/schemas/email'
import { applyDeliveryEvent, suppress, unsuppress } from '../services/email'

const router = Router()

/**
 * COMMS-01 — the send log and the suppression list.
 *
 * Email only. There is deliberately no SMS or WhatsApp surface here; the nav's
 * WhatsApp Connect entry stays an unavailable module in V1.
 */

function toEntry(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status,
    errorMessage: row.error_message ?? null,
    saleId: row.sale_id ?? null,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
  }
}

router.get('/log', requireRole('manager'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const rows = await client.email_log.findMany({
    orderBy: { created_at: 'desc' },
    take: 200,
  })

  const counts = { sent: 0, delivered: 0, failed: 0, bounced: 0, suppressed: 0 }
  for (const row of rows) {
    if (row.status === 'sent') counts.sent += 1
    else if (row.status === 'delivered') counts.delivered += 1
    else if (row.status === 'failed') counts.failed += 1
    else if (row.status === 'bounced' || row.status === 'complained') counts.bounced += 1
    else if (row.status === 'suppressed') counts.suppressed += 1
  }

  return res.json({
    entries: rows.map(toEntry),
    counts,
    providerConfigured: Boolean(process.env.RESEND_API_KEY),
  })
})

router.get('/suppressions', requireRole('manager'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const rows = await client.email_suppressions.findMany({ orderBy: { created_at: 'desc' } })
  return res.json({
    suppressions: rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      reason: row.reason,
      detail: row.detail ?? null,
      createdAt: row.created_at.toISOString(),
    })),
  })
})

router.post('/suppressions', requireRole('owner'), async (req, res) => {
  const parsed = CreateSuppressionSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Give a valid email address and a reason.' })
  }
  await suppress(req.user!.tenantId, parsed.data.email, parsed.data.reason, parsed.data.detail)
  return res.status(201).json({ ok: true })
})

router.delete('/suppressions', requireRole('owner'), async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email : ''
  if (!email) return res.status(400).json({ error: 'Say which address to allow again.' })
  const removed = await unsuppress(req.user!.tenantId, email)
  if (!removed) return res.status(404).json({ error: 'That address is not on the suppression list.' })
  return res.json({ ok: true })
})

/**
 * Delivery events from the provider.
 *
 * Mounted behind the same tenant auth as everything else rather than as an
 * open webhook: an unauthenticated endpoint that suppresses an address on
 * request is a denial-of-service on a store's receipts. Wiring a real provider
 * webhook means adding signature verification and a tenant lookup in front of
 * this, which is deliberately not faked here.
 */
router.post('/events', requireRole('owner'), async (req, res) => {
  const parsed = DeliveryEventSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'That delivery event could not be read.' })
  }
  await applyDeliveryEvent(req.user!.tenantId, parsed.data)
  return res.json({ ok: true })
})

export default router
