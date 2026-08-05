import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { basePrisma } from '../db/prisma'
import { applyWebhookEvent, webhookTarget } from '../services/billing'
import { RazorpayConfigurationError, verifyRazorpayWebhookSignature } from '../services/razorpay'

function providerEventId(req: Request, rawBody: Buffer): string {
  return req.header('x-razorpay-event-id')?.trim()
    || createHash('sha256').update(rawBody).digest('hex')
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002')
}

/** Public only to Razorpay: signature verification is the authentication boundary. */
export async function razorpayWebhookHandler(req: Request, res: Response) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))
  const signature = req.header('x-razorpay-signature')
  if (!signature) return res.status(400).json({ error: 'Missing Razorpay webhook signature' })

  try {
    if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ error: 'Invalid Razorpay webhook signature' })
    }
  } catch (error) {
    if (error instanceof RazorpayConfigurationError) return res.status(error.status).json({ error: error.message })
    throw error
  }

  let body: any
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' })
  }

  const eventName = typeof body?.event === 'string' ? body.event : 'unknown'
  const eventId = providerEventId(req, rawBody)
  let event: any
  try {
    event = await basePrisma.billing_webhook_events.create({
      data: { provider_event_id: eventId, event_name: eventName, payload: body },
    })
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(200).json({ received: true, duplicate: true })
    throw error
  }

  const target = webhookTarget(body)
  if (!target.tenantId || !target.providerSubscriptionId) {
    await basePrisma.billing_webhook_events.update({
      where: { id: event.id },
      data: { processed_at: new Date() },
    })
    // Signature-valid events without our notes are retained for support but
    // cannot be safely attached to a tenant, so they never unlock access.
    return res.status(200).json({ received: true, correlated: false })
  }

  const updated = await applyWebhookEvent({
    tenantId: target.tenantId,
    eventName,
    providerSubscriptionId: target.providerSubscriptionId,
    providerSubscription: target.providerSubscription,
    providerPayment: target.providerPayment,
    providerEventId: eventId,
  })

  if (!updated) {
    // A webhook can race the response that persists the provider ID locally.
    // Returning a non-2xx makes Razorpay retry instead of silently losing a
    // state transition that may affect entitlement.
    return res.status(503).json({ error: 'Subscription is not ready for webhook reconciliation' })
  }

  await basePrisma.billing_webhook_events.update({
    where: { id: event.id },
    data: { tenant_id: target.tenantId, processed_at: new Date() },
  })
  return res.status(200).json({ received: true, correlated: true })
}
