import { Client } from 'pg'

const adminUrl = process.env.DATABASE_URL
const runtimeUrl = process.env.RLS_DATABASE_URL

if (!adminUrl || !runtimeUrl) {
  throw new Error('DATABASE_URL and RLS_DATABASE_URL are required for the production schema gate')
}

const runtimePassword = decodeURIComponent(new URL(runtimeUrl).password)
if (!runtimePassword || runtimePassword === 'CHANGE_ME_VIA_ALTER_ROLE') {
  throw new Error('RLS_DATABASE_URL must contain a provisioned runtime credential')
}

const admin = new Client({ connectionString: adminUrl })
const runtime = new Client({ connectionString: runtimeUrl })

try {
  await admin.connect()
  await runtime.connect()

  const migrations = await admin.query(
    `select name
       from supabase_migrations.schema_migrations
      where name = any($1::text[])`,
    [['0036_billing_subscriptions', '0037_counter_device_staff_sessions', '0039_preserve_supabase_role_claim', '0040_harden_security_definer_acl']],
  )
  const applied = new Set(migrations.rows.map((row) => row.name))
  const requiredMigrations = [
    '0036_billing_subscriptions',
    '0037_counter_device_staff_sessions',
    '0039_preserve_supabase_role_claim',
    '0040_harden_security_definer_acl',
  ]
  const missingMigrations = requiredMigrations.filter((name) => !applied.has(name))
  if (missingMigrations.length > 0) {
    throw new Error(`Missing production migrations: ${missingMigrations.join(', ')}`)
  }

  const roleResult = await admin.query(
    `select rolcanlogin, rolsuper, rolbypassrls, rolpassword is not null as has_password
       from pg_authid
      where rolname = 'app_runtime'`,
  )
  const role = roleResult.rows[0]
  if (!role || !role.rolcanlogin || role.rolsuper || role.rolbypassrls || !role.has_password) {
    throw new Error('app_runtime must be a login role with a password, without superuser or BYPASSRLS')
  }

  const tables = await admin.query(
    `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any($1::text[])`,
    [['billing_subscriptions', 'staff_sessions']],
  )
  const tableMap = new Map(tables.rows.map((row) => [row.relname, row]))
  for (const table of ['billing_subscriptions', 'staff_sessions']) {
    if (!tableMap.get(table)?.relrowsecurity) {
      throw new Error(`Required RLS table is missing or RLS is disabled: ${table}`)
    }
  }

  const hook = await admin.query(
    `select p.prosecdef, p.proconfig
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'custom_access_token_hook'`,
  )
  const hookRow = hook.rows[0]
  if (!hookRow?.prosecdef || !hookRow.proconfig?.some((value) => String(value).startsWith('search_path='))) {
    throw new Error('custom_access_token_hook is not SECURITY DEFINER with a pinned search_path')
  }

  const runtimeIdentity = await runtime.query('select current_user as current_user')
  if (runtimeIdentity.rows[0]?.current_user !== 'app_runtime') {
    throw new Error('RLS_DATABASE_URL does not connect as app_runtime')
  }

  console.log('Production schema gate passed: migrations, runtime role, RLS tables, auth hook, and runtime identity verified.')
} finally {
  await Promise.allSettled([admin.end(), runtime.end()])
}
