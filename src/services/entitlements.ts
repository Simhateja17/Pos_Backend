import { forTenantTransaction } from '../db/tenantClient'
import type { BillingCycle, BillingRegion } from '../contracts/schemas/billing'
import {
  ENTITLEMENT_KEYS,
  calculateQuote,
  getPlan,
  getPlans,
  includedStoresForPlan,
  type BillingEntitlementLimits,
  type EntitlementKey,
  type EntitlementValue,
} from './billingCatalog'
import { OPEN_SUBSCRIPTION_STATUSES, subscriptionAccessForRow, trialAccessForRow, type SubscriptionAccess } from './billingAccess'

export const ENTITLEMENT_VERSION = 'india-mvp-04-v1'
export const POS_ENTITLEMENT_KEY: EntitlementKey = 'monthlyPosTransactions'

export type EntitlementSnapshot = {
  version: string
  planKey: string
  region: BillingRegion
  limits: BillingEntitlementLimits
}

export type EntitlementUsage = {
  businessMonth: string
  locations: number
  activeUsers: number
  activeRegisters: number
  monthlyPosTransactions: number
}

export type EntitlementSource = 'subscription' | 'trial' | 'free' | 'blocked'

export type EntitlementSummary = {
  planKey: string
  region: BillingRegion
  source: EntitlementSource
  access: SubscriptionAccess
  snapshot: EntitlementSnapshot
  usage: EntitlementUsage
}

export type EntitlementDecision = {
  allowed: boolean
  code: 'allowed' | 'entitlement_limit_reached'
  key: EntitlementKey
  limit: EntitlementValue
  usage: number
  reason: string | null
}

export class EntitlementLimitError extends Error {
  public readonly status = 403
  public readonly code = 'entitlement_limit_reached' as const
  public readonly expose = true

  constructor(
    public readonly key: EntitlementKey,
    public readonly limit: EntitlementValue,
    public readonly usage: number,
    reason?: string,
  ) {
    super(reason ?? `${key} limit reached`)
    this.name = 'EntitlementLimitError'
  }
}

export class EntitlementAccessError extends Error {
  public readonly status = 402
  public readonly code = 'billing_required' as const
  public readonly expose = true

  constructor() {
    super('An active subscription or trial is required to use this entitlement.')
    this.name = 'EntitlementAccessError'
  }
}

export class EntitlementPlanError extends Error {
  public readonly expose = true

  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'EntitlementPlanError'
  }
}

function isEntitlementValue(value: unknown): value is EntitlementValue {
  return value === 'unlimited' || (Number.isSafeInteger(value) && Number(value) >= 0)
}

function isLimits(value: unknown): value is BillingEntitlementLimits {
  if (!value || typeof value !== 'object') return false
  const limits = value as Record<string, unknown>
  return ENTITLEMENT_KEYS.every((key) => isEntitlementValue(limits[key]))
}

function isRegion(value: unknown): value is BillingRegion {
  return value === 'IN' || value === 'US'
}

function lowestPlan(region: BillingRegion) {
  try {
    const value = (entry: EntitlementValue) => entry === 'unlimited' ? Number.MAX_SAFE_INTEGER : entry
    return [...getPlans(region)].sort((left, right) => {
      const leftScore = value(left.entitlements.maxLocations) + value(left.entitlements.maxActiveUsers) + value(left.entitlements.maxActiveRegisters)
      const rightScore = value(right.entitlements.maxLocations) + value(right.entitlements.maxActiveUsers) + value(right.entitlements.maxActiveRegisters)
      return leftScore - rightScore
    })[0]
  } catch {
    return undefined
  }
}

function safePlanKey(region: BillingRegion): string {
  return lowestPlan(region)?.key ?? (region === 'IN' ? 'free' : 'essentials')
}

/**
 * Resolve a plan into a durable snapshot. Unknown keys deliberately resolve
 * to the first catalogue plan for the region, which is the lowest-capacity
 * plan in the backend-owned catalogue. A malformed snapshot is never trusted.
 */
export function snapshotForPlan(region: BillingRegion, planKey: string): EntitlementSnapshot {
  try {
    const plan = getPlan(region, planKey) ?? lowestPlan(region)
    if (plan) {
      return {
        version: ENTITLEMENT_VERSION,
        planKey: plan.key,
        region,
        limits: { ...plan.entitlements },
      }
    }
  } catch {
    // A broken environment override must fail down to the hard-coded safe
    // defaults below, rather than granting the requested unknown plan.
  }

  const fallback: BillingEntitlementLimits = region === 'IN'
    ? {
        maxLocations: 1,
        maxActiveUsers: 1,
        maxActiveRegisters: 1,
        monthlyPosTransactions: 50,
        monthlySalesOrders: 50,
        monthlyEcommerceOrders: 50,
        monthlyPurchaseOrders: 20,
        monthlyBills: 20,
        dailyApiCalls: 1_500,
        integrations: 0,
      }
    : {
        maxLocations: 1,
        maxActiveUsers: 'unlimited',
        maxActiveRegisters: 'unlimited',
        monthlyPosTransactions: 'unlimited',
        monthlySalesOrders: 'unlimited',
        monthlyEcommerceOrders: 'unlimited',
        monthlyPurchaseOrders: 'unlimited',
        monthlyBills: 'unlimited',
        dailyApiCalls: 'unlimited',
        integrations: 0,
      }
  return { version: ENTITLEMENT_VERSION, planKey: safePlanKey(region), region, limits: fallback }
}

function parseStoredSnapshot(value: unknown, region: BillingRegion, fallbackPlanKey: string): EntitlementSnapshot {
  if (!value || typeof value !== 'object') return snapshotForPlan(region, fallbackPlanKey)
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== ENTITLEMENT_VERSION
    || typeof candidate.planKey !== 'string'
    || !isRegion(candidate.region)
    || candidate.region !== region
    || !isLimits(candidate.limits)
  ) {
    return snapshotForPlan(region, fallbackPlanKey)
  }

  // The stored snapshot is the authority for an existing subscriber. Its
  // plan key may legitimately disappear from the mutable catalogue after a
  // rename/retirement; the versioned, shape-validated limits must still win.
  return {
    version: candidate.version,
    planKey: candidate.planKey,
    region,
    limits: { ...(candidate.limits as BillingEntitlementLimits) },
  }
}

export function snapshotFromStoredRow(row: any, region: BillingRegion, fallbackPlanKey = 'free'): EntitlementSnapshot {
  if (row?.entitlement_snapshot === undefined || row?.entitlement_snapshot === null) {
    return snapshotForPlan(region, row?.plan_key ?? fallbackPlanKey)
  }
  return parseStoredSnapshot(row.entitlement_snapshot, region, fallbackPlanKey)
}

export function resolveCurrentAccessState(subscriptionRow: any, trialRow: any, now = new Date()): SubscriptionAccess {
  if (subscriptionRow) return subscriptionAccessForRow(subscriptionRow, now)
  if (trialRow) return trialAccessForRow(trialRow, now)
  return { entitlement: 'blocked', accessAllowed: false, graceUntil: null }
}

export function decideEntitlement(
  key: EntitlementKey,
  limit: EntitlementValue,
  usage: number,
  label?: string,
): EntitlementDecision {
  if (limit === 'unlimited' || usage < limit) {
    return { allowed: true, code: 'allowed', key, limit, usage, reason: null }
  }

  return {
    allowed: false,
    code: 'entitlement_limit_reached',
    key,
    limit,
    usage,
    reason: `${label ?? key} limit reached (${usage}/${limit}). Upgrade your plan to continue.`,
  }
}

export function usageForEntitlement(summary: EntitlementSummary, key: EntitlementKey): number | null {
  switch (key) {
    case 'maxLocations': return summary.usage.locations
    case 'maxActiveUsers': return summary.usage.activeUsers
    case 'maxActiveRegisters': return summary.usage.activeRegisters
    case 'monthlyPosTransactions': return summary.usage.monthlyPosTransactions
    default:
      // Future resources have stored limits but no implemented resource or
      // usage source. Returning null prevents callers from fabricating usage.
      return null
  }
}

function numberValue(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  const number = Number(value ?? 0)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

function monthFallback(now: Date): string {
  return `${now.getUTCFullYear().toString().padStart(4, '0')}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}-01`
}

async function readSubscriptionRow(tx: any, tenantId: string): Promise<any | null> {
  try {
    const rows = await tx.$queryRaw<any[]>`
      SELECT *
      FROM public.billing_subscriptions
      WHERE tenant_id = ${tenantId}::uuid
        AND status IN (${OPEN_SUBSCRIPTION_STATUSES[0]}, ${OPEN_SUBSCRIPTION_STATUSES[1]}, ${OPEN_SUBSCRIPTION_STATUSES[2]}, ${OPEN_SUBSCRIPTION_STATUSES[3]}, ${OPEN_SUBSCRIPTION_STATUSES[4]})
      ORDER BY updated_at DESC
      LIMIT 1
    `
    return rows[0] ?? null
  } catch {
    // Unit tests and a pre-migration local client may not expose raw SQL. The
    // legacy model read remains a safe fallback; it simply has no snapshot.
    return tx.billing_subscriptions?.findFirst?.({
      where: { tenant_id: tenantId, status: { in: [...OPEN_SUBSCRIPTION_STATUSES] } },
      orderBy: { updated_at: 'desc' },
    }) ?? null
  }
}

async function readTrialRow(tx: any, tenantId: string): Promise<any | null> {
  try {
    const rows = await tx.$queryRaw<any[]>`
      SELECT *
      FROM public.billing_trials
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `
    return rows[0] ?? null
  } catch {
    // The table is introduced by the accompanying migration and deliberately
    // has no Prisma model until the integrator refreshes the snapshot.
    return null
  }
}

async function readPosUsage(
  tx: any,
  tenantId: string,
  timezone: string,
  now: Date,
): Promise<{ businessMonth: string; count: number }> {
  try {
    const rows = await tx.$queryRaw<Array<{ business_month: string; used_count: unknown }>>`
      SELECT
        date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date::text AS business_month,
        COALESCE(SUM(used_count), 0)::bigint AS used_count
      FROM public.entitlement_usage_counters
      WHERE tenant_id = ${tenantId}::uuid
        AND entitlement_key = ${POS_ENTITLEMENT_KEY}
        AND business_month = date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date
    `
    return {
      businessMonth: rows[0]?.business_month ?? monthFallback(now),
      count: numberValue(rows[0]?.used_count),
    }
  } catch {
    // Before 0057 is applied, derive the read from committed POS sales. The
    // reservation/enforcement write still requires the migration, so this
    // fallback is read-only and cannot create an unsafe quota path.
    try {
      const rows = await tx.$queryRaw<Array<{ business_month: string; used_count: unknown }>>`
        SELECT
          date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date::text AS business_month,
          COUNT(*)::bigint AS used_count
        FROM public.sales
        WHERE tenant_id = ${tenantId}::uuid
          AND source = 'pos'
          AND import_batch_id IS NULL
          AND status = 'completed'
          AND date_trunc('month', created_at AT TIME ZONE ${timezone})::date = date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date
      `
      return {
        businessMonth: rows[0]?.business_month ?? monthFallback(now),
        count: numberValue(rows[0]?.used_count),
      }
    } catch {
      return { businessMonth: monthFallback(now), count: 0 }
    }
  }
}

async function readUsage(tx: any, tenantId: string, timezone: string, now: Date): Promise<EntitlementUsage> {
  const [locations, activeUsers, activeRegisters, pos] = await Promise.all([
    tx.stores.count({ where: { tenant_id: tenantId, is_active: true } }),
    tx.staff_members.count({ where: { tenant_id: tenantId, is_active: true } }),
    tx.terminals.count({ where: { tenant_id: tenantId, is_active: true } }),
    readPosUsage(tx, tenantId, timezone, now),
  ])

  return {
    businessMonth: pos.businessMonth,
    locations: numberValue(locations),
    activeUsers: numberValue(activeUsers),
    activeRegisters: numberValue(activeRegisters),
    monthlyPosTransactions: pos.count,
  }
}

export async function resolveEntitlementSummary(tx: any, tenantId: string, now = new Date()): Promise<EntitlementSummary> {
  const [tenant, subscription, trial] = await Promise.all([
    tx.tenants.findFirst({ where: { id: tenantId }, select: { country: true, timezone: true } }),
    readSubscriptionRow(tx, tenantId),
    readTrialRow(tx, tenantId),
  ])

  const region: BillingRegion = (tenant?.country ?? '').trim().toUpperCase() === 'IN' ? 'IN' : 'US'
  const source: EntitlementSource = subscription
    ? 'subscription'
    : trial
      ? 'trial'
      : region === 'IN'
        ? 'free'
        : 'blocked'
  const snapshot = subscription
    ? snapshotFromStoredRow(subscription, region)
    : trial
      ? snapshotFromStoredRow(trial, region)
      : snapshotForPlan(region, region === 'IN' ? 'free' : 'essentials')

  return {
    planKey: snapshot.planKey,
    region,
    source,
    access: resolveCurrentAccessState(subscription, trial, now),
    snapshot,
    usage: await readUsage(tx, tenantId, tenant?.timezone || 'UTC', now),
  }
}

export async function getEntitlementSummary(tenantId: string, now = new Date()): Promise<EntitlementSummary> {
  return forTenantTransaction(tenantId, (tx) => resolveEntitlementSummary(tx, tenantId, now))
}

export function entitlementStatusFields(summary: EntitlementSummary) {
  return {
    planKey: summary.planKey,
    region: summary.region,
    entitlementSource: summary.source,
    entitlementVersion: summary.snapshot.version,
    entitlements: summary.snapshot.limits,
    usage: summary.usage,
  }
}

export type FreeSubscriptionInput = {
  billingCycle: BillingCycle
  idempotencyKey: string
}

/**
 * Activate the zero-cost India plan without creating a provider attempt.
 *
 * The billing table still remains the access source of truth: using an active
 * row lets the existing onboarding and request gates work unchanged, while
 * the migration trigger gives the row the same durable entitlement snapshot
 * as a paid subscription. Locking the tenant row makes two first-time Free
 * clicks converge on one subscription instead of racing the open-subscription
 * partial unique index.
 */
export async function activateFreeSubscription(tenantId: string, input: FreeSubscriptionInput) {
  const plan = getPlan('IN', 'free')
  if (!plan) throw new EntitlementPlanError(500, 'The India Free plan is not configured')
  const quote = calculateQuote(plan, input.billingCycle)

  return forTenantTransaction(tenantId, async (tx) => {
    const tenants = await tx.$queryRaw<Array<{ id: string; country: string | null }>>`
      SELECT id, country
      FROM public.tenants
      WHERE id = ${tenantId}::uuid
      FOR UPDATE
    `
    if (tenants.length === 0) throw new EntitlementPlanError(404, 'Tenant not found')
    if ((tenants[0].country ?? '').trim().toUpperCase() !== 'IN') {
      throw new EntitlementPlanError(400, 'The Free plan is available only in the India catalogue')
    }

    const existing = await tx.$queryRaw<any[]>`
      SELECT *
      FROM public.billing_subscriptions
      WHERE tenant_id = ${tenantId}::uuid
        AND status IN (${OPEN_SUBSCRIPTION_STATUSES[0]}, ${OPEN_SUBSCRIPTION_STATUSES[1]}, ${OPEN_SUBSCRIPTION_STATUSES[2]}, ${OPEN_SUBSCRIPTION_STATUSES[3]}, ${OPEN_SUBSCRIPTION_STATUSES[4]})
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE
    `
    if (existing[0]) {
      if (existing[0].region === 'IN' && existing[0].plan_key === 'free' && existing[0].entitlement_status === 'active') {
        return freeSubscriptionResponse(existing[0], input, quote)
      }
      throw new EntitlementPlanError(409, 'This account already has an active subscription. Plan changes are scheduled for a future billing cycle.')
    }

    const providerSubscriptionId = `free_${tenantId}_${input.idempotencyKey}`
    const created = await tx.$queryRaw<any[]>`
      INSERT INTO public.billing_subscriptions (
        tenant_id,
        provider_subscription_id,
        provider_plan_id,
        region,
        plan_key,
        billing_cycle,
        currency,
        base_amount_minor,
        tax_amount_minor,
        total_amount_minor,
        tax_rate_bps,
        included_store_count,
        additional_store_count,
        status,
        entitlement_status,
        current_start_at,
        provider_payload
      ) VALUES (
        ${tenantId}::uuid,
        ${providerSubscriptionId},
        'free',
        'IN',
        'free',
        ${input.billingCycle},
        'INR',
        ${quote.baseAmountMinor},
        ${quote.taxAmountMinor},
        ${quote.totalAmountMinor},
        ${quote.taxRateBps},
        ${includedStoresForPlan('free')},
        0,
        'active',
        'active',
        now(),
        jsonb_build_object('source', 'free_plan', 'idempotency_key', ${input.idempotencyKey})
      )
      RETURNING *
    `
    return freeSubscriptionResponse(created[0], input, quote)
  })
}

function freeSubscriptionResponse(row: any, input: FreeSubscriptionInput, quote: ReturnType<typeof calculateQuote>) {
  return {
    attemptId: row.id,
    razorpayKeyId: '',
    razorpaySubscriptionId: row.provider_subscription_id,
    status: row.status,
    region: 'IN' as const,
    planKey: 'free',
    billingCycle: row.billing_cycle ?? input.billingCycle,
    currency: 'INR' as const,
    quote,
  }
}

export type PosTransactionReservation = EntitlementDecision & {
  counted: boolean
  replayed: boolean
}

export type PosTransactionReservationInput = {
  tenantId: string
  storeId: string
  sourceKey: string
  source?: string
  imported?: boolean
  status?: string
  now?: Date
}

/**
 * Reserve one committed POS transaction inside the sale transaction.
 *
 * The migration's unique event key makes retries idempotent. The counter's
 * conditional upsert is the concurrency guard: two transactions can never
 * both move a finite counter beyond its snapshotted limit. If the counter is
 * full, the just-created event is removed in the same transaction and the
 * caller must not write the sale.
 *
 * Integration point for the sales owner:
 * `const reservation = await reservePosTransaction(tx, input)`
 * `if (!reservation.allowed) throw new EntitlementLimitError(reservation.key, reservation.limit, reservation.usage, reservation.reason ?? undefined)`
 * Place it before the first sale/line/payment/stock write, inside the existing
 * `forTenantTransaction`; the enclosing rollback guarantees no partial sale.
 */
export async function reservePosTransaction(
  tx: any,
  input: PosTransactionReservationInput,
): Promise<PosTransactionReservation> {
  const source = input.source ?? 'pos'
  const status = input.status ?? 'completed'
  if (source !== 'pos' || input.imported || status !== 'completed') {
    return {
      allowed: true,
      code: 'allowed',
      key: POS_ENTITLEMENT_KEY,
      limit: 'unlimited',
      usage: 0,
      reason: null,
      counted: false,
      replayed: false,
    }
  }

  const now = input.now ?? new Date()
  const summary = await resolveEntitlementSummary(tx, input.tenantId, now)
  if (!summary.access.accessAllowed) throw new EntitlementAccessError()
  const limit = summary.snapshot.limits[POS_ENTITLEMENT_KEY]
  const timezone = await timezoneForTenant(tx, input.tenantId)
  const eventRows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO public.entitlement_usage_events
      (tenant_id, store_id, entitlement_key, business_month, source_key, units)
    VALUES (
      ${input.tenantId}::uuid,
      ${input.storeId}::uuid,
      ${POS_ENTITLEMENT_KEY},
      date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date,
      ${input.sourceKey},
      1
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `

  if (eventRows.length === 0) {
    return {
      allowed: true,
      code: 'allowed',
      key: POS_ENTITLEMENT_KEY,
      limit,
      usage: summary.usage.monthlyPosTransactions,
      reason: null,
      counted: false,
      replayed: true,
    }
  }

  // A zero-valued finite entitlement has no insertable counter state. Remove
  // the idempotency event before returning the same stable boundary error that
  // the conditional counter update uses for a full counter.
  if (limit !== 'unlimited' && limit <= 0) {
    await tx.$executeRaw`
      DELETE FROM public.entitlement_usage_events
      WHERE tenant_id = ${input.tenantId}::uuid
        AND store_id = ${input.storeId}::uuid
        AND entitlement_key = ${POS_ENTITLEMENT_KEY}
        AND source_key = ${input.sourceKey}
    `
    const decision = decideEntitlement(POS_ENTITLEMENT_KEY, limit, 0, 'POS transactions')
    return { ...decision, counted: false, replayed: false }
  }

  const counterRows = limit === 'unlimited'
    ? await tx.$queryRaw<Array<{ used_count: unknown }>>`
        INSERT INTO public.entitlement_usage_counters
          (tenant_id, store_id, entitlement_key, business_month, used_count)
        VALUES (
          ${input.tenantId}::uuid,
          ${input.storeId}::uuid,
          ${POS_ENTITLEMENT_KEY},
          date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date,
          1
        )
        ON CONFLICT DO UPDATE SET used_count = public.entitlement_usage_counters.used_count + 1
        RETURNING used_count
      `
    : await tx.$queryRaw<Array<{ used_count: unknown }>>`
        INSERT INTO public.entitlement_usage_counters
          (tenant_id, store_id, entitlement_key, business_month, used_count)
        VALUES (
          ${input.tenantId}::uuid,
          ${input.storeId}::uuid,
          ${POS_ENTITLEMENT_KEY},
          date_trunc('month', ${now}::timestamptz AT TIME ZONE ${timezone})::date,
          1
        )
        ON CONFLICT DO UPDATE
          SET used_count = public.entitlement_usage_counters.used_count + 1
          WHERE public.entitlement_usage_counters.used_count < ${limit}
        RETURNING used_count
      `

  if (counterRows.length === 0) {
    await tx.$executeRaw`
      DELETE FROM public.entitlement_usage_events
      WHERE tenant_id = ${input.tenantId}::uuid
        AND store_id = ${input.storeId}::uuid
        AND entitlement_key = ${POS_ENTITLEMENT_KEY}
        AND source_key = ${input.sourceKey}
    `
    const decision = decideEntitlement(POS_ENTITLEMENT_KEY, limit, Number(limit), 'POS transactions')
    return { ...decision, counted: false, replayed: false }
  }

  const usage = numberValue(counterRows[0]?.used_count)
  return {
    ...decideEntitlement(POS_ENTITLEMENT_KEY, limit, usage - 1, 'POS transactions'),
    counted: true,
    replayed: false,
  }
}

async function timezoneForTenant(tx: any, tenantId: string): Promise<string> {
  try {
    const tenant = await tx.tenants.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    return typeof tenant?.timezone === 'string' && tenant.timezone.trim() ? tenant.timezone : 'UTC'
  } catch {
    return 'UTC'
  }
}

export function assertEntitlementDecision(decision: EntitlementDecision): void {
  if (!decision.allowed) {
    throw new EntitlementLimitError(decision.key, decision.limit, decision.usage, decision.reason ?? undefined)
  }
}
