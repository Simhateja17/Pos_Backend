import { basePrisma } from './prisma'

const DEFAULT_MAX_WAIT_MS = 10_000
const DEFAULT_TRANSACTION_TIMEOUT_MS = 15_000
const DEFAULT_RETRY_BASE_MS = 50
const MAX_START_RETRIES = 2

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const TENANT_TRANSACTION_OPTIONS = {
  // Prisma's defaults (2s maxWait / 5s timeout) are too small for a
  // persistent VM talking through Supavisor. These remain bounded; they are
  // not a license to leave a transaction open indefinitely.
  maxWait: positiveEnvInt('PRISMA_TX_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS),
  timeout: positiveEnvInt('PRISMA_TX_TIMEOUT_MS', DEFAULT_TRANSACTION_TIMEOUT_MS),
}

function isTransactionStartTimeout(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'P2028' &&
      typeof (error as { message?: unknown }).message === 'string' &&
      (error as { message: string }).message.includes('Unable to start a transaction'),
  )
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Retries only the pre-callback connection-acquisition form of P2028. A
 * callback that has started is never replayed, so writes cannot be duplicated
 * by this resilience guard.
 */
async function runTenantTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await basePrisma.$transaction(callback, TENANT_TRANSACTION_OPTIONS)
    } catch (error) {
      if (!isTransactionStartTimeout(error) || attempt >= MAX_START_RETRIES) {
        throw error
      }
      const base = positiveEnvInt('PRISMA_TX_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS)
      const jitter = Math.floor(Math.random() * base)
      await sleep(base * 2 ** attempt + jitter)
      attempt += 1
    }
  }
}

/**
 * forTenant(tenantId) returns a Prisma Client Extension that wraps every query
 * in a single interactive transaction: SET (session-local) app.tenant_id first,
 * then dispatch the real operation against that same transaction client.
 *
 * This is the mechanism that makes Postgres RLS policies (which read
 * current_setting('app.tenant_id', true)) actually see the tenant, since
 * Prisma talks directly to Postgres and never goes through Supabase's
 * PostgREST layer (which sets this automatically via its own JWT parsing).
 *
 * Source: pattern from prisma/prisma-client-extensions (row-level-security
 * example), which is explicitly documented upstream as "not intended for
 * production" — hardened here by connecting `basePrisma` only via the
 * restricted `app_runtime` role (NOBYPASSRLS), never the postgres superuser.
 * https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security
 *
 * CAVEAT: nested `$transaction()` calls from route code will conflict with
 * this per-query transaction wrapping (Prisma does not support nesting
 * interactive transactions). Multi-step workflows must use
 * `forTenantTransaction()` directly. High-volume read paths should also use
 * that helper so one request acquires one transaction instead of one per
 * query.
 */
export function forTenant(tenantId: string) {
  if (!tenantId) {
    throw new Error('tenantId is required')
  }

  return basePrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, operation, model }) {
          return runTenantTransaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
            // re-dispatch the original operation against the transaction client
            return (tx as any)[model!][operation](args)
          })
        },
      },
    },
  })
}

/**
 * forTenantTransaction(tenantId, fn) — CR-02: opens
 * exactly ONE basePrisma.$transaction for the whole callback, sets
 * app.tenant_id once at the top (so RLS sees the tenant for every operation
 * run against `tx` inside `fn`), and returns fn's result. Use this instead of
 * forTenant() whenever a route needs multiple writes (e.g. across models) to
 * either all commit or all roll back together — forTenant()'s per-operation
 * transaction wrapping cannot provide that, and nested $transaction() calls
 * from route code are not supported by Prisma.
 *
 * The callback receives the raw transaction client (`tx`), NOT a
 * forTenant()-wrapped client — do not call forTenant() again inside `fn`,
 * and do not mix in a `client` obtained from forTenant() within the same
 * request path, since that would open a second, independent transaction.
 */
export async function forTenantTransaction<T>(
  tenantId: string,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error('tenantId is required')
  }

  return runTenantTransaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx)
  })
}
