import { Resend } from 'resend'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

export interface ReceiptEmailInput {
  to: string
  saleId: string
  totalAmount: string
  businessName: string
}

/**
 * Sends the receipt email (CHECK-06). On the ORIGINAL charge path
 * (POST /sales), callers invoke this AFTER the sale transaction has already
 * committed and must NOT await its result before responding — a failed/slow
 * email must not make the sale appear to have failed (UI-SPEC copy contract:
 * "The sale is saved — try emailing it again..."). The dedicated
 * POST /sales/:id/resend-receipt endpoint, by contrast, DOES await this
 * function directly, since reporting the real send outcome synchronously is
 * that endpoint's entire purpose.
 *
 * T-03-15: on failure this returns only a generic-ish message (the caught
 * error's own message) that is logged server-side by the caller — neither the
 * fire-and-forget charge-time call nor the resend endpoint ever forwards this
 * raw error string back to the HTTP client.
 */
export async function sendReceiptEmail(input: ReceiptEmailInput): Promise<{ ok: boolean; error?: string }> {
  if (!resend) {
    return { ok: false, error: 'RESEND_API_KEY not configured' }
  }
  try {
    await resend.emails.send({
      from: 'receipts@couture-pos.example.com',
      to: input.to,
      subject: `Bill from ${input.businessName} — ${input.totalAmount}`,
      text: `Thank you for your purchase. Bill ${input.saleId}: ${input.totalAmount} total.`,
    })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Unknown error sending bill email' }
  }
}
