import 'dotenv/config'
import { createPlatformAdmin, findPlatformAdminByEmail, inviteAuthUser, listPlatformAdmins } from '../src/services/adminStore'

type SeedOwner = { email: string; displayName: string }

const CONFIRMATION = 'CREATE-REGIONAL-PLATFORM-OWNERS'

function fail(message: string): never {
  throw new Error(`[admin-seed] ${message}`)
}

function parseOwners(): SeedOwner[] {
  const raw = process.env.ADMIN_SEED_OWNERS?.trim()
  if (!raw) fail('Set ADMIN_SEED_OWNERS to a JSON array of at least two {email,displayName} objects')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('ADMIN_SEED_OWNERS must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length < 2) fail('At least two Platform Owners are required before MFA recovery can be enabled')
  const owners = parsed.map((value) => {
    if (!value || typeof value !== 'object') fail('Each owner must be an object')
    const email = String((value as { email?: unknown }).email ?? '').trim().toLowerCase()
    const displayName = String((value as { displayName?: unknown }).displayName ?? '').trim()
    if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || displayName.length > 120) fail('Each owner needs a valid email and a display name of 1-120 characters')
    return { email, displayName }
  })
  const uniqueEmails = new Set(owners.map((owner) => owner.email))
  if (uniqueEmails.size !== owners.length) fail('Owner emails must be unique')
  return owners
}

async function main() {
  const region = process.env.ADMIN_REGION?.trim().toUpperCase()
  if (region !== 'IN' && region !== 'INTL') fail('ADMIN_REGION must be explicitly set to IN or INTL')
  if (!process.argv.includes('--confirm') || process.env.ADMIN_SEED_CONFIRM !== CONFIRMATION) {
    fail(`This is a one-time server-side seed. Re-run with --confirm and ADMIN_SEED_CONFIRM=${CONFIRMATION}`)
  }

  const owners = parseOwners()
  const existing = await listPlatformAdmins()
  const existingOwners = existing.filter((admin) => admin.role === 'platform_owner' && admin.status !== 'suspended')
  if (existingOwners.length > 0) fail(`This region already has ${existingOwners.length} active/invited Platform Owner account(s); refusing a second seed`)

  for (const owner of owners) {
    const duplicate = await findPlatformAdminByEmail(owner.email)
    if (duplicate) fail(`An administrator row already exists for ${owner.email}; no rows were changed`)
  }

  for (const owner of owners) {
    const authUser = await inviteAuthUser(owner.email)
    const admin = await createPlatformAdmin({
      authUserId: authUser.id,
      email: owner.email,
      displayName: owner.displayName,
      role: 'platform_owner',
      invitedBy: null,
    })
    console.log(`[admin-seed] invited ${admin.email} as ${region} Platform Owner (${admin.id})`)
  }
  console.log('[admin-seed] complete; keep ADMIN_PANEL_ENABLED=false until both owners complete OTP + TOTP acceptance')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

