import { basePrisma } from './prisma'

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
 * interactive transactions). Acceptable for Phase 1's scope (simple CRUD,
 * no cross-model transactional writes yet) — flag for revisit once
 * Phase 2/3 need multi-step transactional writes (e.g. checkout, stock
 * movements), which will likely need a request-scoped transaction
 * (AsyncLocalStorage-based) instead of a per-call one.
 */
export function forTenant(tenantId: string) {
  if (!tenantId) {
    throw new Error('tenantId is required')
  }

  return basePrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, operation, model }) {
          return basePrisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
            // re-dispatch the original operation against the transaction client
            return (tx as any)[model!][operation](args)
          })
        },
      },
    },
  })
}
