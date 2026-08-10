import { createClient } from '@supabase/supabase-js'

/**
 * Real email-OTP minting for the integration suites.
 *
 * POST /api/auth/login and /api/auth/signup take `{ email, otp }` and verify
 * the code server-side with `supabaseAnon.auth.verifyOtp`. A test therefore
 * needs a genuinely valid 6-digit code, but must not depend on an email
 * actually being delivered.
 *
 * `auth.admin.generateLink` is the supported way out: it mints the same code
 * the email would have carried and returns it as `properties.email_otp`
 * WITHOUT sending anything. The code is then accepted by
 * `verifyOtp({ type: 'email' })` exactly as a user-typed one would be — so
 * these tests still drive the real verification path, with no mock and no
 * stub anywhere between the request and Supabase Auth.
 *
 * Use `type: 'magiclink'` for an existing (already-confirmed) user, which is
 * what the seed fixture creates. `type: 'signup'` is for an address that has
 * no auth user yet.
 */
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

/** A wrong-but-well-formed code: passes the 6-digit schema, fails verification. */
export const WRONG_OTP = '000000'

async function mint(email: string, type: 'magiclink' | 'signup'): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type, email } as never)
  const otp = data?.properties?.email_otp
  if (error || !otp) {
    throw new Error(`otp.ts: could not mint a ${type} OTP for ${email}: ${error?.message ?? 'no email_otp on the response'}`)
  }
  return otp
}

/** Mints a login OTP for an email that already has a confirmed auth user. */
export function loginOtpFor(email: string): Promise<string> {
  return mint(email, 'magiclink')
}

/** Mints a signup OTP for an email that has no auth user yet. */
export function signupOtpFor(email: string): Promise<string> {
  return mint(email, 'signup')
}
