import { Resend } from 'resend'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

export interface ActivationEmailInput {
  to: string
  activationUrl: string
}

/**
 * Sends the "activate your store" email that carries a single-use web sign-in
 * link. The mobile app never opens a checkout itself (store billing rules), so
 * this email is the owner's path to the web plans page.
 *
 * The URL contains bearer material: never log it, and never return it to the
 * HTTP client.
 */
export async function sendActivationEmail(input: ActivationEmailInput): Promise<{ ok: boolean; error?: string }> {
  if (!resend) {
    return { ok: false, error: 'RESEND_API_KEY not configured' }
  }
  try {
    await resend.emails.send({
      from: 'support@ambelpos.com',
      to: input.to,
      subject: 'Activate your Ambel POS store',
      text: [
        'Your Ambel POS account is ready.',
        '',
        'Choose a plan to start using your store. This link signs you in on the web automatically and works once:',
        input.activationUrl,
        '',
        'If the link has expired, open the Ambel POS app and tap "Resend email".',
        "If you didn't create an Ambel POS account, you can ignore this email.",
      ].join('\n'),
    })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Unknown error sending activation email' }
  }
}
