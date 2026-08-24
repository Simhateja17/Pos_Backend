import { activeStoreId, storeScopeWhere } from '../middleware/storeContext'
import { Router } from 'express'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { generateReorderSuggestions, type SkippedVariant } from '../services/reorder-heuristic'
import { requireRole } from '../middleware/requireRole'
import { randomUUID } from 'node:crypto'

const router = Router()

const MANUAL_FORECAST_POLL_MS = 5_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ForecastRunRow = {
  id: string
  store_id: string
  source: 'manual_test' | 'nightly'
  status: 'queued' | 'running' | 'completed' | 'failed'
  requested_at: Date
  started_at: Date | null
  completed_at: Date | null
  heartbeat_at: Date | null
  products_evaluated: number
  products_eligible: number
  forecasts_won: number
  forecasts_written: number
  products_skipped: number
  error_code: string | null
  error_message: string | null
  worker_version: string | null
  model_version: string | null
}

function manualForecastEnabled(): boolean {
  return process.env.ENABLE_MANUAL_FORECAST === 'true'
}

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null
}

function forecastRunJson(row: ForecastRunRow) {
  return {
    id: row.id,
    storeId: row.store_id,
    source: row.source,
    status: row.status,
    requestedAt: new Date(row.requested_at).toISOString(),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    heartbeatAt: iso(row.heartbeat_at),
    productsEvaluated: Number(row.products_evaluated ?? 0),
    productsEligible: Number(row.products_eligible ?? 0),
    forecastsWon: Number(row.forecasts_won ?? 0),
    forecastsWritten: Number(row.forecasts_written ?? 0),
    productsSkipped: Number(row.products_skipped ?? 0),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    workerVersion: row.worker_version,
    modelVersion: row.model_version,
    manualForecastEnabled: manualForecastEnabled(),
  }
}

async function findForecastRun(tenantId: string, storeId: string, runId: string): Promise<ForecastRunRow | null> {
  return forTenantTransaction(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ForecastRunRow[]>`
      select id, store_id, source, status, requested_at, started_at, completed_at,
             heartbeat_at, products_evaluated, products_eligible, forecasts_won,
             forecasts_written, products_skipped, error_code, error_message,
             worker_version, model_version
      from public.forecast_runs
      where id = ${runId}::uuid and tenant_id = ${tenantId}::uuid and store_id = ${storeId}::uuid
      limit 1
    `
    return rows[0] ?? null
  })
}

export function toSuggestionJson(row: any) {
  const reason = row.reason ?? {}
  return {
    id: row.id,
    variantId: row.variant_id,
    sku: row.variants?.sku ?? '',
    productName: row.variants?.products?.name ?? '',
    supplierId: row.supplier_id,
    supplierName: row.suppliers?.name ?? null,
    suggestedQuantity: Number(row.suggested_quantity),
    method: row.method,
    confidence: row.confidence,
    // Rows generated before the structured ML-03 contract used `stock`.
    // Normalize at the API boundary so every client receives `currentStock`.
    reason: {
      ...reason,
      currentStock: Number(reason.currentStock ?? reason.stock ?? 0),
    },
    generatedAt: row.generated_at.toISOString(),
  }
}

/**
 * In-memory cache of the skipped list from the most recent generation run.
 * Skipped variants are explanatory context, not persisted facts — they are
 * regenerated whenever suggestions are, and an empty list after a restart
 * simply means "not computed since boot", which the UI reports honestly
 * rather than as "nothing was skipped".
 */
const lastSkipped = new Map<string, SkippedVariant[]>()

/**
 * GET / — the current suggestions for this tenant, newest run only.
 *
 * Deliberately does NOT generate on read: an owner refreshing a page should
 * see the same numbers, not a silently different set computed against stock
 * that moved between requests.
 */
router.get('/suggestions', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any

  // Suggestions are per shop, so "the latest run" must mean the latest run FOR
  // THIS SHOP — otherwise a shop that has not generated recently would show
  // another shop's run timestamp and then an empty list.
  const storeScope = storeScopeWhere(req)
  const latest = await client.reorder_suggestions.findFirst({
    where: { ...storeScope },
    orderBy: { generated_at: 'desc' },
  })
  if (!latest) {
    return res.json({ generatedAt: null, items: [], skipped: [], manualForecastEnabled: manualForecastEnabled() })
  }

  const rows = await client.reorder_suggestions.findMany({
    where: { generated_at: latest.generated_at, ...storeScope },
    include: { variants: { include: { products: true } }, suppliers: true },
    orderBy: { suggested_quantity: 'desc' },
  })

  res.json({
    generatedAt: latest.generated_at.toISOString(),
    items: rows.map(toSuggestionJson),
    skipped: lastSkipped.get(req.user!.tenantId) ?? [],
    manualForecastEnabled: manualForecastEnabled(),
  })
})

/**
 * POST /generate — recompute suggestions for this tenant.
 *
 * Manager+ only: this replaces every existing suggestion, which changes what
 * the whole team sees on the Inventory screen.
 */
router.post('/generate', requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId

  try {
    const result = await forTenantTransaction(tenantId, async (tx) => generateReorderSuggestions(tx, tenantId, activeStoreId(req)))
    lastSkipped.set(tenantId, result.skipped)

    const client = forTenant(tenantId) as any
    const rows = await client.reorder_suggestions.findMany({
      where: { generated_at: result.generatedAt, store_id: activeStoreId(req) },
      include: { variants: { include: { products: true } }, suppliers: true },
      orderBy: { suggested_quantity: 'desc' },
    })

    return res.json({
      generatedAt: result.generatedAt.toISOString(),
      items: rows.map(toSuggestionJson),
      skipped: result.skipped,
      manualForecastEnabled: manualForecastEnabled(),
    })
  } catch (err: any) {
    const status = Number.isInteger(err?.status) ? err.status : 500
    return res.status(status).json({
      error: status >= 500 ? 'Could not generate reorder suggestions' : err.message ?? 'Could not generate reorder suggestions',
    })
  }
})

/**
 * POST /forecast-runs — testing-only asynchronous ML trigger.
 *
 * The request is a database queue entry. This handler never imports Python,
 * starts a child process, or calls systemd; the restricted VM worker claims it
 * independently. The partial unique index protects the active-run race while
 * the read-before-insert gives duplicate clicks the existing run immediately.
 */
router.post('/forecast-runs', requireRole('manager'), async (req, res) => {
  if (!manualForecastEnabled()) {
    return res.status(404).json({ error: 'Manual forecast testing is not enabled.' })
  }

  const tenantId = req.user!.tenantId
  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Select one store before running a forecast.' })
  }
  const rawKey = req.headers['idempotency-key']
  const idempotencyKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim() || randomUUID()
  if (idempotencyKey.length > 128) {
    return res.status(400).json({ error: 'Idempotency-Key must be at most 128 characters.' })
  }

  try {
    const run = await forTenantTransaction(tenantId, async (tx) => {
      const replay = await tx.$queryRaw<ForecastRunRow[]>`
        select id, store_id, source, status, requested_at, started_at, completed_at,
               heartbeat_at, products_evaluated, products_eligible, forecasts_won,
               forecasts_written, products_skipped, error_code, error_message,
               worker_version, model_version
        from public.forecast_runs
        where tenant_id = ${tenantId}::uuid and store_id = ${storeId}::uuid
          and idempotency_key = ${idempotencyKey}
        limit 1
      `
      if (replay[0]) return replay[0]

      const active = await tx.$queryRaw<ForecastRunRow[]>`
        select id, store_id, source, status, requested_at, started_at, completed_at,
               heartbeat_at, products_evaluated, products_eligible, forecasts_won,
               forecasts_written, products_skipped, error_code, error_message,
               worker_version, model_version
        from public.forecast_runs
        where tenant_id = ${tenantId}::uuid and store_id = ${storeId}::uuid
          and source = 'manual_test' and status in ('queued', 'running')
        order by requested_at asc
        limit 1
        for update
      `
      if (active[0]) return active[0]

      const ownerStaff = req.actingStaff
        ? null
        : await tx.staff_members.findFirst({
            where: { user_id: req.user!.id, is_active: true },
            select: { id: true },
          })
      const requestedBy = req.actingStaff?.id ?? ownerStaff?.id ?? null
      const inserted = await tx.$queryRaw<ForecastRunRow[]>`
          insert into public.forecast_runs
            (tenant_id, store_id, requested_by, source, status, idempotency_key)
          values
            (${tenantId}::uuid, ${storeId}::uuid, ${requestedBy}::uuid, 'manual_test', 'queued', ${idempotencyKey})
          on conflict do nothing
          returning id, store_id, source, status, requested_at, started_at, completed_at,
                    heartbeat_at, products_evaluated, products_eligible, forecasts_won,
                    forecasts_written, products_skipped, error_code, error_message,
                    worker_version, model_version
      `
      if (inserted[0]) return inserted[0]

      // The active partial unique index closes the last race between two
      // requests. Return the winner rather than leaking a 500 to the UI.
      const winner = await tx.$queryRaw<ForecastRunRow[]>`
          select id, store_id, source, status, requested_at, started_at, completed_at,
                 heartbeat_at, products_evaluated, products_eligible, forecasts_won,
                 forecasts_written, products_skipped, error_code, error_message,
                 worker_version, model_version
          from public.forecast_runs
          where tenant_id = ${tenantId}::uuid and store_id = ${storeId}::uuid
            and source = 'manual_test' and status in ('queued', 'running')
          order by requested_at asc limit 1
      `
      if (!winner[0]) throw new Error('Forecast queue conflict did not return an active run')
      return winner[0]
    })

    return res.status(202).json({ run: forecastRunJson(run), pollAfterMs: MANUAL_FORECAST_POLL_MS })
  } catch (error: any) {
    console.error(`[reorder:forecast-run:create] ${error instanceof Error ? error.message : String(error)}`)
    return res.status(500).json({ error: 'Could not queue the manual forecast.' })
  }
})

router.get('/forecast-runs/:runId', requireRole('manager'), async (req, res) => {
  const runId = String(req.params.runId)
  if (!UUID_PATTERN.test(runId)) return res.status(400).json({ error: 'Invalid forecast run id.' })
  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Select one store before viewing a forecast.' })
  }
  const run = await findForecastRun(req.user!.tenantId, storeId, runId)
  if (!run) return res.status(404).json({ error: 'Forecast run not found.' })
  return res.json(forecastRunJson(run))
})

router.get('/forecast-runs/:runId/items', requireRole('manager'), async (req, res) => {
  const tenantId = req.user!.tenantId
  const runId = String(req.params.runId)
  if (!UUID_PATTERN.test(runId)) return res.status(400).json({ error: 'Invalid forecast run id.' })
  let storeId: string
  try {
    storeId = activeStoreId(req)
  } catch {
    return res.status(400).json({ error: 'Select one store before viewing a forecast.' })
  }
  const run = await findForecastRun(tenantId, storeId, runId)
  if (!run) return res.status(404).json({ error: 'Forecast run not found.' })

  const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10)
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100))
  const rows = await forTenantTransaction(tenantId, async (tx) => tx.$queryRaw<any[]>`
    select fri.id, fri.run_id, fri.variant_id, v.sku, p.name product_name,
           fri.history_days, fri.trailing_units, fri.total_units, fri.eligible,
           fri.supplier_id, fri.supplier_lead_days, fri.review_days,
           fri.forecast_horizon_days, fri.rule_based, fri.ml_result,
           fri.disposition, fri.reason_code
    from public.forecast_run_items fri
    join public.variants v on v.id = fri.variant_id
    join public.products p on p.id = v.product_id
      where fri.tenant_id = ${tenantId}::uuid and fri.run_id = ${runId}::uuid
      and fri.store_id = ${storeId}::uuid
    order by fri.created_at asc
    limit ${limit}
  `)

  return res.json({
    items: rows.map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      variantId: row.variant_id,
      sku: row.sku,
      productName: row.product_name,
      historyDays: row.history_days === null ? null : Number(row.history_days),
      trailingUnits: Number(row.trailing_units ?? 0),
      totalUnits: Number(row.total_units ?? 0),
      eligible: Boolean(row.eligible),
      supplierId: row.supplier_id,
      supplierLeadDays: row.supplier_lead_days === null ? null : Number(row.supplier_lead_days),
      reviewDays: Number(row.review_days ?? 7),
      forecastHorizonDays: row.forecast_horizon_days === null ? null : Number(row.forecast_horizon_days),
      ruleBased: row.rule_based ?? {},
      mlResult: row.ml_result ?? {},
      disposition: row.disposition,
      reasonCode: row.reason_code,
    })),
    nextCursor: null,
  })
})

export default router
