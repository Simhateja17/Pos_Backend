import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcrypt'
import { SignupSchema, LoginSchema, OtpRequestSchema, SetPinSchema, OwnerPinRecoveryRequestSchema } from '../contracts/schemas/auth'
import { STARTER_CATEGORIES } from '../contracts/schemas/category'
import { authMiddleware, decodeJwtPayload, getStaffRoleClaim } from '../middleware/auth'
import { forTenant } from '../db/tenantClient'
import { clearAuthCookies, getAuthCookies, setAuthCookies } from '../lib/authCookies'

const router = Router()

// Logs the local part length instead of the raw address so pm2 logs are
// traceable ("who hit this route") without putting real emails in plaintext.
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  return `${local.slice(0, 2)}***@${domain}`
}

// ADMIN client — service-role key, the highest-privilege credential in this
// phase. Confined to exactly this file, and only used for
// auth.admin.createUser/deleteUser (Supabase Auth account bootstrap during
// signup). NEVER used for any tenant-scoped route (those exclusively use
// forTenant()/basePrisma per 01-05/01-06/01-08). T-1-05.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

// Anon-key client — used only to mint a real session via
// auth.signInWithPassword (both signup's session-minting step and login).
// Never hand-rolls password verification/hashing; Supabase Auth owns that
// entirely (01-RESEARCH.md Don't Hand-Roll table).
const supabaseAnon = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_ANON_KEY as string,
)

/**
 * POST /otp/request — sends a 6-digit email OTP via Supabase Auth. Always
 * responds 200 regardless of whether the account exists, to avoid leaking
 * account existence through response timing/shape (same enumeration
 * concern as /login below). `purpose: 'signup'` allows Supabase to create
 * the underlying Auth user on verification; `purpose: 'login'` does not,
 * so an OTP is only actually delivered to already-registered addresses.
 */
router.post('/otp/request', async (req, res) => {
  const parsed = OtpRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const { email, purpose } = parsed.data
  console.log(`[auth:otp/request] purpose=${purpose} email=${maskEmail(email)}`)

  const { error } = await supabaseAnon.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: purpose === 'signup' },
  })

  if (error) {
    console.log(`[auth:otp/request] Supabase signInWithOtp error status=${error.status} code=${(error as { code?: string }).code} message=${error.message}`)
  } else {
    console.log(`[auth:otp/request] Supabase signInWithOtp ok — code should be in-flight to the provider`)
  }

  // A 422 here is Supabase's "no account exists and shouldCreateUser is
  // false" response — the expected, privacy-preserving outcome for a login
  // attempt against an unregistered email. Masked as success so the
  // response never reveals whether the address has an account. Anything
  // else (5xx: SMTP/provider failure, etc.) is a real delivery failure and
  // must be surfaced — silently reporting "sent" when nothing was sent
  // just strands the caller waiting for a code that will never arrive.
  if (error && error.status !== 422) {
    console.log(`[auth:otp/request] returning 502 — real send failure, not the expected 422`)
    return res.status(502).json({ error: 'Could not send the code. Please try again shortly.' })
  }

  return res.status(200).json({ ok: true })
})

/**
 * POST /signup — real self-serve signup (D-05/D-06): creates a Supabase Auth
 * user, a tenants row with the full business/tax profile, and an owner
 * staff_members row, in one flow.
 *
 * SECURITY / RLS NOTE: basePrisma connects as app_runtime (NOBYPASSRLS) — a
 * plain unscoped insert into tenants/staff_members would be rejected by the
 * tenant_isolation_* RLS policies' WITH CHECK clause (current_setting(
 * 'app.tenant_id', true) is NULL pre-creation, and NULL = anything is never
 * true). Rather than requiring a second, more-privileged Postgres role just
 * for this one bootstrap write, this route generates the new tenant's id
 * up front (randomUUID()) and uses the SAME forTenant(tenantId) mechanism
 * every other tenant-scoped write uses — set_config('app.tenant_id', <new id>)
 * — then inserts the tenants row with that id explicitly. The WITH CHECK
 * clause is satisfied because the row's own id now equals the just-set
 * app.tenant_id, and the following staff_members insert reuses the same
 * tenantId. This keeps app_runtime's NOBYPASSRLS invariant intact even for
 * tenant creation itself — no RLS bypass is introduced anywhere.
 * (Deviation from this plan's literal "plain basePrisma write" instruction —
 * see 01-07-SUMMARY.md.)
 */
router.post('/signup', async (req, res) => {
  const parsed = SignupSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const {
    email,
    otp,
    ownerName,
    businessName,
    tradeName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    taxId,
    gstStatus,
    pan,
    placeOfSupply,
  } = parsed.data
  console.log(`[auth:signup] email=${maskEmail(email)} otpLength=${otp.length}`)

  // Verifying the OTP both confirms the caller owns this email address and
  // (shouldCreateUser: true was passed at /otp/request time) creates the
  // Supabase Auth user if it didn't already exist. There is no separate
  // admin.createUser step — Supabase Auth owns account creation entirely,
  // same "don't hand-roll" principle as the old password flow.
  const { data: verifyData, error: verifyError } = await supabaseAnon.auth.verifyOtp({
    email,
    token: otp,
    type: 'email',
  })

  if (verifyError || !verifyData?.user || !verifyData.session) {
    console.log(`[auth:signup] verifyOtp failed status=${verifyError?.status} code=${(verifyError as { code?: string } | undefined)?.code} message=${verifyError?.message}`)
    return res.status(401).json({ error: 'Invalid or expired code' })
  }
  console.log(`[auth:signup] verifyOtp ok userId=${verifyData.user.id}`)

  const newUser = verifyData.user

  // A pre-existing store owner's custom-hook JWT carries tenant_id (same
  // claim /login relies on). verifyOtp on an already-registered email logs
  // them in rather than erroring, so this is the only signal that
  // distinguishes "new email" from "this store already exists" here.
  try {
    const existingClaims = decodeJwtPayload(verifyData.session.access_token)
    if (existingClaims.tenant_id) {
      console.log(`[auth:signup] userId=${newUser.id} already has tenant_id claim — duplicate account, 409`)
      return res.status(409).json({
        error: 'An account already exists with this email. Log in instead',
      })
    }
  } catch (decodeError) {
    console.log(`[auth:signup] decodeJwtPayload threw: ${decodeError instanceof Error ? decodeError.message : decodeError}`)
    return res.status(401).json({ error: 'Invalid or expired code' })
  }

  const tenantId = randomUUID()
  console.log(`[auth:signup] userId=${newUser.id} creating tenant=${tenantId}`)

  try {
    const tenantScoped = forTenant(tenantId)
    const tenant = await tenantScoped.tenants.create({
      data: {
        id: tenantId,
        business_name: businessName,
        trade_name: tradeName ?? null,
        address_line1: addressLine1,
        address_line2: addressLine2 ?? null,
        city,
        state,
        postal_code: postalCode,
        country,
        tax_id: taxId ?? null,
        gst_status: gstStatus ?? null,
        pan: pan ?? null,
        place_of_supply: placeOfSupply ?? null,
      },
    })

    // Phase 8: a tenant is a BUSINESS and must own at least one store. Migration
    // 0041 backfilled every pre-existing tenant; this is the equivalent for new
    // signups. Without it a fresh tenant would have no store, and every
    // store-scoped write (sale, stock movement, shift) would fail on the NOT
    // NULL store_id added in 0043/0044.
    //
    // Named and addressed from the business itself, exactly as 0041's backfill
    // does, so a single-shop owner never sees a shop they didn't create.
    const store = await tenantScoped.stores.create({
      data: {
        tenant_id: tenantId,
        name: tradeName ?? businessName,
        address_line1: addressLine1,
        address_line2: addressLine2 ?? null,
        city,
        state,
        postal_code: postalCode,
        country,
      },
    })

    await tenantScoped.staff_members.create({
      data: {
        tenant_id: tenantId,
        store_id: store.id,
        user_id: newUser.id,
        name: ownerName,
        role: 'owner',
        is_active: true,
      },
    })

    // A general starter category list, so a brand-new catalog is never a blank
    // "no categories yet" prompt. /store-type layers a business-specific list
    // on top of this later (additive — nothing here is removed by that).
    for (const [index, name] of STARTER_CATEGORIES.general.entries()) {
      await tenantScoped.categories.create({
        data: { tenant_id: tenantId, name, sort_order: index },
      })
    }

    await tenantScoped.notifications.create({
      data: {
        tenant_id: tenantId,
        type: 'business_type_unset',
        title: 'Set your business type',
        body: 'Pick what kind of shop this is and we will suggest a starting list of categories for your catalog.',
        link: '/store-type',
      },
    })

    // The OTP-verify session above was minted before the staff_members row
    // existed, so the custom access token hook had nothing to attach —
    // refreshing re-runs the hook now that this user has a tenant, the same
    // "mint the session only after the tenant exists" ordering the old
    // signInWithPassword call gave us.
    const { data: refreshed, error: refreshError } = await supabaseAnon.auth.refreshSession({
      refresh_token: verifyData.session.refresh_token,
    })

    if (refreshError || !refreshed?.session) {
      console.log(`[auth:signup] tenant=${tenantId} created but refreshSession failed status=${refreshError?.status} message=${refreshError?.message}`)
      return res.status(500).json({ error: 'Account created but failed to start a session. Please log in.' })
    }

    console.log(`[auth:signup] tenant=${tenantId} userId=${newUser.id} complete — 201`)
    res.set('Cache-Control', 'no-store')
    setAuthCookies(res, refreshed.session.access_token, refreshed.session.refresh_token)

    return res.status(201).json({
      user: {
        id: newUser.id,
        email,
        role: 'owner',
        tenantId: tenant.id,
      },
      session: {
        accessToken: refreshed.session.access_token,
        refreshToken: refreshed.session.refresh_token,
      },
    })
  } catch (writeError) {
    console.log(`[auth:signup] tenant=${tenantId} userId=${newUser.id} write step threw: ${writeError instanceof Error ? writeError.stack ?? writeError.message : writeError}`)
    // Partial-failure cleanup: an orphaned Supabase Auth user with no
    // tenant/staff row is worse than a failed signup — best-effort delete,
    // never let a cleanup failure mask the original 500.
    try {
      await supabaseAdmin.auth.admin.deleteUser(newUser.id)
    } catch (cleanupError) {
      console.log(`[auth:signup] cleanup deleteUser(${newUser.id}) also failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`)
    }
    return res.status(500).json({ error: 'Failed to create account. Please try again.' })
  }
})

/**
 * POST /login — email+OTP via Supabase Auth. Never reads role/tenantId from
 * the request body — both are derived from the custom access token hook's
 * claims on the session verifyOtp returns.
 *
 * SECURITY (Information Disclosure, mitigated): both "no such user" and
 * "wrong/expired code" map to the same generic 401 copy, preventing user
 * enumeration.
 */
router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const { email, otp } = parsed.data
  console.log(`[auth:login] email=${maskEmail(email)} otpLength=${otp.length}`)

  const { data, error } = await supabaseAnon.auth.verifyOtp({ email, token: otp, type: 'email' })

  if (error || !data?.session || !data.user) {
    console.log(`[auth:login] verifyOtp failed status=${error?.status} code=${(error as { code?: string } | undefined)?.code} message=${error?.message}`)
    return res.status(401).json({ error: 'Invalid or expired code' })
  }
  console.log(`[auth:login] verifyOtp ok userId=${data.user.id}`)

  // Role/tenantId come from the JWT's custom claims (written server-side by
  // the Custom Access Token Hook), NOT a basePrisma DB lookup. A direct
  // app_runtime (NOBYPASSRLS) query here is a dead end: RLS's USING clause
  // requires app.tenant_id, which we don't have yet at login time and can't
  // set in advance since discovering the tenant is the whole point of this
  // lookup — there is no bypass, confirmed during 01-07's signup work. The
  // hook already resolved this at token-issuance time, so decode it from
  // there instead, the same way authMiddleware does for every other route.
  let claims: Record<string, unknown>
  try {
    claims = decodeJwtPayload(data.session.access_token)
  } catch (decodeError) {
    console.log(`[auth:login] decodeJwtPayload threw: ${decodeError instanceof Error ? decodeError.message : decodeError}`)
    return res.status(401).json({ error: 'Invalid or expired code' })
  }

  const role = getStaffRoleClaim(claims)
  const tenantId = claims.tenant_id as (string | undefined)

  if (!role || !tenantId) {
    console.log(`[auth:login] userId=${data.user.id} missing role/tenant_id claim (role=${role} tenantId=${tenantId}) — no staff_members row?`)
    return res.status(401).json({ error: 'Invalid or expired code' })
  }
  console.log(`[auth:login] userId=${data.user.id} role=${role} tenantId=${tenantId} — 200`)

  res.set('Cache-Control', 'no-store')
  setAuthCookies(res, data.session.access_token, data.session.refresh_token)

  return res.status(200).json({
    user: {
      id: data.user.id,
      email: data.user.email,
      role,
      tenantId,
    },
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    },
  })
})

router.post('/logout', async (req, res) => {
  const { accessToken } = getAuthCookies(req)
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length).trim()
    : undefined
  const token = bearerToken ?? accessToken

  if (token) {
    const { error } = await supabaseAdmin.auth.admin.signOut(token, 'global')
    if (error) {
      console.error('[auth:logout] Supabase session revocation failed', error)
      clearAuthCookies(res)
      return res.status(503).json({ error: 'Could not end the secure session. Please try again.' })
    }
  }

  clearAuthCookies(res)
  return res.status(204).send()
})

router.get('/session', async (req, res) => {
  const { accessToken, refreshToken } = getAuthCookies(req)
  if (!accessToken && !refreshToken) return res.json({ authenticated: false })
  const session = accessToken && refreshToken
    ? await supabaseAnon.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
    : null
  if (!session?.data.session) {
    clearAuthCookies(res)
    return res.json({ authenticated: false })
  }
  setAuthCookies(res, session.data.session.access_token, session.data.session.refresh_token)
  return res.json({ authenticated: true })
})

/**
 * POST /set-pin — an authenticated staff member (owner, manager, or a
 * newly-activated invited manager/cashier) provisions/changes their own PIN
 * (closes the plan-checker BLOCKER: 01-06's validatePin only ever compared
 * against an existing hash, and no route wrote one for real, non-seed staff).
 *
 * SECURITY (T-1-11, Elevation of Privilege, mitigated): gated behind
 * authMiddleware (a real Supabase session is required — this is NOT the
 * PIN-switch mechanism), and the target row is resolved EXCLUSIVELY via
 * req.user.id/req.user.tenantId from verified JWT claims — never a
 * client-supplied staffId/memberId — so no caller can ever set another
 * staff member's PIN through this endpoint.
 */
router.post('/set-pin', authMiddleware, async (req, res) => {
  const parsed = SetPinSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid PIN', details: parsed.error.flatten() })
  }

  const pinHash = await bcrypt.hash(parsed.data.pin, 10)
  const client = forTenant(req.user!.tenantId) as any

  // Read first so a repeat PIN reset doesn't re-fire the activation
  // notification — pin_hash going NULL -> set happens exactly once, the
  // first time an invited staff member completes account activation.
  const existing = await client.staff_members.findFirst({ where: { user_id: req.user!.id } })
  const isFirstActivation = existing !== null && existing.pin_hash === null

  // updateMany (not update): the lookup key is user_id, not the primary key
  // id — Prisma's update requires a unique/primary-key where clause, and
  // user_id isn't declared as a DB-level unique constraint in 01-02's
  // schema, so updateMany is the safe choice that doesn't assume a
  // constraint that doesn't exist.
  const updated = await client.staff_members.updateMany({
    where: { user_id: req.user!.id },
    data: { pin_hash: pinHash, pin_must_change: false, pin_attempts: 0, pin_locked_until: null },
  })

  if (updated.count === 0) {
    // req.user.id has no matching staff_members row — shouldn't happen for
    // a real authenticated staff session, but fail loudly rather than
    // silently succeeding.
    return res.status(404).json({ error: 'No staff record found for this account' })
  }

  if (isFirstActivation && existing) {
    await client.notifications.create({
      data: {
        tenant_id: req.user!.tenantId,
        type: 'staff_activated',
        title: 'A staff member is now active',
        body: `${existing.name} has set up their account and can now sign in.`,
        link: '/app/settings/members',
        metadata: { staffMemberId: existing.id },
      },
    })
  }

  return res.status(200).json({ ok: true })
})

/**
 * POST /owner-pin-recovery/request — sends a Supabase Auth recovery link to
 * an owner who has forgotten their counter PIN. Uses
 * resetPasswordForEmail (not the OTP flow above) because the link itself,
 * not a typed code, is what /reset-owner-pin exchanges for a session.
 *
 * SECURITY: always 200 with the same body regardless of whether the email
 * belongs to an account — matches /otp/request and /login's enumeration
 * defence. A 502 is the one exception, and is a real provider failure, not
 * information about the account.
 */
router.post('/owner-pin-recovery/request', async (req, res) => {
  const parsed = OwnerPinRecoveryRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  const { email } = parsed.data
  console.log(`[auth:owner-pin-recovery:request] email=${maskEmail(email)}`)

  const redirectTo = process.env.OWNER_PIN_RECOVERY_REDIRECT_URL
  const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, { redirectTo })

  if (error) {
    console.log(`[auth:owner-pin-recovery:request] Supabase resetPasswordForEmail error status=${error.status} message=${error.message}`)
    // A real send failure (provider down) is distinguishable server-side
    // and does not leak account existence — "we could not send anything"
    // is true regardless of whether the address is registered.
    return res.status(502).json({ error: 'Could not send recovery email' })
  }

  return res.status(200).json({ ok: true })
})

/**
 * POST /owner-pin-recovery/confirm — the authenticated recovery-link session
 * (exchanged client-side by /reset-owner-pin via supabase.auth.getSession(),
 * same mechanism the Supabase JS client uses for any recovery link) sets a
 * new 4-digit PIN for the CURRENT owner and revokes their other active PIN
 * sessions, so a stolen-but-unused old session cannot ride along.
 *
 * authMiddleware resolves req.user from the verified JWT exactly as it does
 * for every other route — role and tenantId come from the custom access
 * token hook's claims, never from client input.
 */
router.post('/owner-pin-recovery/confirm', authMiddleware, async (req, res) => {
  if (req.user!.role !== 'owner') {
    return res.status(403).json({ error: 'Owner role required' })
  }

  const parsed = SetPinSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid PIN', details: parsed.error.flatten() })
  }

  const pinHash = await bcrypt.hash(parsed.data.pin, 10)
  const client = forTenant(req.user!.tenantId) as any

  const updated = await client.staff_members.updateMany({
    where: { user_id: req.user!.id },
    data: { pin_hash: pinHash, pin_must_change: false, pin_attempts: 0, pin_locked_until: null },
  })

  if (updated.count === 0) {
    return res.status(404).json({ error: 'No staff record found for this account' })
  }

  // Revoke this owner's other active PIN-switch sessions — a recovery is a
  // credential reset, and an old session minted under the forgotten PIN
  // must not keep working after it.
  await client.staff_sessions.updateMany({
    where: { staff_id: req.user!.id, logged_out_at: null },
    data: { logged_out_at: new Date() },
  })

  return res.status(200).json({ ok: true })
})

export default router
