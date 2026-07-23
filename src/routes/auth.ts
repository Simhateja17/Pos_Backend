import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcrypt'
import { SignupSchema, LoginSchema, SetPinSchema } from '../contracts/schemas/auth'
import { authMiddleware } from '../middleware/auth'
import { forTenant } from '../db/tenantClient'
import { basePrisma } from '../db/prisma'

const router = Router()

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

function isDuplicateEmailError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { status?: number; code?: string; message?: string }
  return (
    err.code === 'email_exists' ||
    err.status === 422 ||
    /already.*(registered|exists)/i.test(err.message ?? '')
  )
}

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
    password,
    ownerName,
    businessName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    taxId,
  } = parsed.data

  const { data: createData, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (createError) {
    if (isDuplicateEmailError(createError)) {
      return res.status(409).json({
        error: 'An account already exists with this email. Log in instead',
      })
    }
    return res.status(500).json({ error: 'Failed to create account. Please try again.' })
  }

  const newUser = createData.user
  if (!newUser) {
    return res.status(500).json({ error: 'Failed to create account. Please try again.' })
  }

  const tenantId = randomUUID()

  try {
    const tenantScoped = forTenant(tenantId)
    const tenant = await tenantScoped.tenants.create({
      data: {
        id: tenantId,
        business_name: businessName,
        address_line1: addressLine1,
        address_line2: addressLine2 ?? null,
        city,
        state,
        postal_code: postalCode,
        country,
        tax_id: taxId ?? null,
      },
    })

    await tenantScoped.staff_members.create({
      data: {
        tenant_id: tenantId,
        user_id: newUser.id,
        name: ownerName,
        role: 'owner',
        is_active: true,
      },
    })

    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError || !signInData?.session) {
      return res.status(500).json({ error: 'Account created but failed to start a session. Please log in.' })
    }

    return res.status(201).json({
      user: {
        id: newUser.id,
        email,
        role: 'owner',
        tenantId: tenant.id,
      },
      session: {
        accessToken: signInData.session.access_token,
        refreshToken: signInData.session.refresh_token,
      },
    })
  } catch {
    // Partial-failure cleanup: an orphaned Supabase Auth user with no
    // tenant/staff row is worse than a failed signup — best-effort delete,
    // never let a cleanup failure mask the original 500.
    try {
      await supabaseAdmin.auth.admin.deleteUser(newUser.id)
    } catch {
      // best-effort only
    }
    return res.status(500).json({ error: 'Failed to create account. Please try again.' })
  }
})

/**
 * POST /login — email+password via Supabase Auth (D-08). Never reads
 * role/tenantId from the request body — both are derived from a DB lookup
 * keyed on the verified auth user id returned by signInWithPassword.
 *
 * SECURITY (Information Disclosure, mitigated): both "no such user" and
 * "wrong password" map to the same generic 401 copy, preventing user
 * enumeration.
 */
router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  const { email, password } = parsed.data

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password })

  if (error || !data?.session || !data.user) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  // Direct basePrisma lookup (not forTenant) is the documented exception here:
  // we don't yet have req.user.tenantId to scope through, and this reads the
  // caller's OWN row by their own verified auth id — not a cross-tenant query.
  const staff = await basePrisma.staff_members.findFirst({
    where: { user_id: data.user.id },
  })

  if (!staff) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  return res.status(200).json({
    user: {
      id: data.user.id,
      email: data.user.email,
      role: staff.role,
      tenantId: staff.tenant_id,
    },
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    },
  })
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

  // updateMany (not update): the lookup key is user_id, not the primary key
  // id — Prisma's update requires a unique/primary-key where clause, and
  // user_id isn't declared as a DB-level unique constraint in 01-02's
  // schema, so updateMany is the safe choice that doesn't assume a
  // constraint that doesn't exist.
  const updated = await forTenant(req.user!.tenantId).staff_members.updateMany({
    where: { user_id: req.user!.id },
    data: { pin_hash: pinHash, pin_attempts: 0, pin_locked_until: null },
  })

  if (updated.count === 0) {
    // req.user.id has no matching staff_members row — shouldn't happen for
    // a real authenticated staff session, but fail loudly rather than
    // silently succeeding.
    return res.status(404).json({ error: 'No staff record found for this account' })
  }

  return res.status(200).json({ ok: true })
})

export default router
