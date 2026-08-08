import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

// Base client connected as the restricted app_runtime role (NOBYPASSRLS).
// NEVER connect this to the postgres superuser connection string — that would silently
// bypass RLS and make success criterion #2 (cross-tenant read refused by Postgres) untestable.
// This is deliberately RLS_DATABASE_URL, not DATABASE_URL (which is the superuser
// connection reserved for Prisma introspection/migrations only, per backend/.env.example).
//
// Prisma 7 removed the constructor-level `datasources.url` override entirely — a
// driver adapter is now required for any non-Accelerate connection. The
// `@prisma/adapter-pg` adapter below uses an explicitly bounded `pg` Pool
// pointed at RLS_DATABASE_URL.
const runtimeConnectionString = process.env.RLS_DATABASE_URL?.trim()
if (!runtimeConnectionString) {
  throw new Error('RLS_DATABASE_URL is required for the runtime Prisma client')
}

let runtimeConnection: URL | undefined
try {
  runtimeConnection = new URL(runtimeConnectionString)
} catch (error) {
  // pg will provide the detailed connection-string error when it connects.
}

if (
  runtimeConnection &&
  (runtimeConnection.port === '6543' || runtimeConnection.searchParams.has('pgbouncer')) &&
  process.env.NODE_ENV === 'production'
) {
  throw new Error('RLS_DATABASE_URL must use a clean Supavisor session-mode URL on port 5432 for the persistent PM2 backend; transaction-mode parameters are not supported')
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Keep the application-side pool deliberately bounded. The process is a
// persistent PM2 worker, so a large default pool only amplifies bursts and can
// starve Supavisor when more workers are added later.
const runtimePool = new Pool({
  connectionString: runtimeConnectionString,
  max: positiveEnvInt('DATABASE_POOL_MAX', 5),
  connectionTimeoutMillis: positiveEnvInt('DATABASE_CONNECTION_TIMEOUT_MS', 10_000),
  idleTimeoutMillis: positiveEnvInt('DATABASE_IDLE_TIMEOUT_MS', 30_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: process.env.DATABASE_APPLICATION_NAME ?? 'ambel-backend',
})

runtimePool.on('error', (error) => {
  console.error(`[db:pool] idle client error: ${error.message}`)
})

if (runtimeConnection?.port === '6543') {
  console.warn('[db:pool] RLS_DATABASE_URL uses Supabase transaction mode (6543); persistent PM2 runtimes should use session mode (5432)')
}

const adapter = new PrismaPg(runtimePool, { disposeExternalPool: true })

export const basePrisma = new PrismaClient({ adapter })
