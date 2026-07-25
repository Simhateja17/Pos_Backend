import { forTenant } from '../db/tenantClient'
import { sendReceiptEmail } from '../lib/receiptEmail'

/**
 * COMMS-01 — logged email delivery.
 *
 * This wraps the existing Resend send path rather than replacing it: the
 * fire-and-forget behaviour on the sale path is load-bearing (a slow provider
 * must never fail a sale) and is left exactly as it was. What is added here is
 * the part that was missing — a row per attempt, a suppression check before
 * sending, and outcome recording afterwards.
 *
 * Transactional vs marketing is the distinction that governs suppression:
 * receipts and invoices are things the customer paid for and are sent even to
 * someone who unsubscribed from offers. A hard bounce or spam complaint stops
 * everything, because continuing to send to a dead address damages the sending
 * domain for every other customer of this store.
 */

export type EmailKind = 'receipt' | 'invoice' | 'offer'

export type SendOutcome = {
  status: 'sent' | 'failed' | 'suppressed'
  logId: string
  reason?: string
}

const TRANSACTIONAL: readonly EmailKind[] = ['receipt', 'invoice']

export function isTransactional(kind: EmailKind): boolean {
  return TRANSACTIONAL.includes(kind)
}

/**
 * Should this address be skipped for this kind of email?
 *
 * Returns the suppression reason when the send must not happen, or null.
 */
export async function suppressionFor(
  tenantId: string,
  email: string,
  kind: EmailKind,
): Promise<{ reason: string; detail: string | null } | null> {
  const client = forTenant(tenantId) as any
  const rows = await client.email_suppressions.findMany({ where: { tenant_id: tenantId } })
  const match = rows.find((row: any) => row.email.toLowerCase() === email.trim().toLowerCase())
  if (!match) return null
  // An unsubscribe covers marketing only. A receipt is not marketing.
  if (match.reason === 'unsubscribed' && isTransactional(kind)) return null
  return { reason: match.reason, detail: match.detail ?? null }
}

export async function suppress(
  tenantId: string,
  email: string,
  reason: 'unsubscribed' | 'bounced' | 'complained',
  detail?: string,
): Promise<void> {
  const client = forTenant(tenantId) as any
  const existing = await client.email_suppressions.findMany({ where: { tenant_id: tenantId } })
  const match = existing.find((row: any) => row.email.toLowerCase() === email.trim().toLowerCase())
  if (match) {
    await client.email_suppressions.update({
      where: { id: match.id },
      data: { reason, detail: detail ?? null },
    })
    return
  }
  await client.email_suppressions.create({
    data: { tenant_id: tenantId, email: email.trim(), reason, detail: detail ?? null },
  })
}

export async function unsuppress(tenantId: string, email: string): Promise<boolean> {
  const client = forTenant(tenantId) as any
  const existing = await client.email_suppressions.findMany({ where: { tenant_id: tenantId } })
  const match = existing.find((row: any) => row.email.toLowerCase() === email.trim().toLowerCase())
  if (!match) return false
  await client.email_suppressions.delete({ where: { id: match.id } })
  return true
}

type SendInput = {
  tenantId: string
  kind: EmailKind
  to: string
  saleId: string | null
  subject: string
  businessName: string
  totalAmount: string
  createdBy?: string | null
}

/**
 * Send and log. Never throws — a caller on the sale path must not be able to
 * fail because of email, and a caller that wants the real outcome reads the
 * returned status.
 */
export async function sendLoggedEmail(input: SendInput): Promise<SendOutcome> {
  const client = forTenant(input.tenantId) as any

  const suppression = await suppressionFor(input.tenantId, input.to, input.kind).catch(() => null)
  if (suppression) {
    const log = await client.email_log.create({
      data: {
        tenant_id: input.tenantId,
        kind: input.kind,
        recipient: input.to,
        subject: input.subject,
        status: 'suppressed',
        sale_id: input.saleId,
        error_message:
          suppression.reason === 'unsubscribed'
            ? 'This customer has unsubscribed from offers.'
            : `Earlier email to this address ${suppression.reason === 'bounced' ? 'bounced' : 'was marked as spam'}.`,
        created_by: input.createdBy ?? null,
      },
      select: { id: true },
    })
    return { status: 'suppressed', logId: log.id, reason: suppression.reason }
  }

  // Logged as queued BEFORE the provider call, so an attempt that crashes
  // mid-flight still leaves evidence it was made rather than vanishing.
  const log = await client.email_log.create({
    data: {
      tenant_id: input.tenantId,
      kind: input.kind,
      recipient: input.to,
      subject: input.subject,
      status: 'queued',
      sale_id: input.saleId,
      attempts: 1,
      last_attempt_at: new Date(),
      created_by: input.createdBy ?? null,
    },
    select: { id: true },
  })

  const outcome = await sendReceiptEmail({
    to: input.to,
    saleId: input.saleId ?? '',
    totalAmount: input.totalAmount,
    businessName: input.businessName,
  }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : 'Unknown error sending email',
  }))

  await client.email_log.update({
    where: { id: log.id },
    data: outcome.ok
      ? { status: 'sent', delivered_at: null }
      : { status: 'failed', failed_at: new Date(), error_message: outcome.error ?? 'Unknown error' },
  })

  return outcome.ok
    ? { status: 'sent', logId: log.id }
    : { status: 'failed', logId: log.id, reason: outcome.error }
}

/**
 * Apply a provider delivery event. Called by the webhook route.
 *
 * A hard bounce or complaint also lands the address on the suppression list —
 * recording the event without acting on it would let the same address be
 * retried on the next sale.
 */
export async function applyDeliveryEvent(
  tenantId: string,
  event: { logId?: string; providerMessageId?: string; recipient: string; type: 'delivered' | 'bounced' | 'complained' },
): Promise<void> {
  const client = forTenant(tenantId) as any

  const candidates = await client.email_log.findMany({
    where: { tenant_id: tenantId },
    orderBy: { created_at: 'desc' },
    take: 200,
  })
  const match = candidates.find(
    (row: any) =>
      (event.logId && row.id === event.logId) ||
      (event.providerMessageId && row.provider_message_id === event.providerMessageId) ||
      row.recipient.toLowerCase() === event.recipient.trim().toLowerCase(),
  )

  if (match) {
    await client.email_log.update({
      where: { id: match.id },
      data:
        event.type === 'delivered'
          ? { status: 'delivered', delivered_at: new Date() }
          : { status: event.type, failed_at: new Date() },
    })
  }

  if (event.type !== 'delivered') {
    await suppress(tenantId, event.recipient, event.type, `Reported by the email provider.`)
  }
}
