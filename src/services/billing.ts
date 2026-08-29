import { forTenant, forTenantTransaction } from '../db/tenantClient'
import type { BillingCycle, BillingRegion, CreateSubscriptionInput } from '../contracts/schemas/billing'
import {
  calculateQuote,
  getBillingMode,
  getPeriod,
  getPlan,
  providerPlanId,
  includedStoresForPlan,
  type BillingPlanDefinition,
} from './billingCatalog'
import {
  cancelRazorpaySubscription,
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  fetchRazorpayPlan,
  findRazorpaySubscriptionByAttemptId,
  getRazorpayConfig,
  RazorpayRequestError,
  type RazorpayPayment,
  type RazorpaySubscription,
  unixSecondsToDate,
  verifyRazorpayCheckoutSignature,
} from './razorpay'
import { OPEN_SUBSCRIPTION_STATUSES, subscriptionAccessForRow } from './billingAccess'

const OPEN_STATUSES = [...OPEN_SUBSCRIPTION_STATUSES]

export class BillingHttpError extends Error {
  public readonly expose = true

  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'BillingHttpError'
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002')
}

export function regionForCountry(country: string | null | undefined): BillingRegion {
  if ((country ?? '').trim().toUpperCase() === 'IN') return 'IN'
  // The international catalogue is denominated in USD. Keep country
  // matching broad enough for the stated US/UK/Gulf rollout without creating
  // a new billing region for every country code.
  return 'INTL'
}

async function tenantRegion(tenantId: string): Promise<BillingRegion> {
  const client = forTenant(tenantId) as any
  const tenant = await client.tenants.findFirst({ where: { id: tenantId }, select: { country: true } })
  if (!tenant) throw new BillingHttpError(404, 'Tenant not found')
  return regionForCountry(tenant.country)
}

async function findAttempt(tenantId: string, attemptId: string): Promise<any | null> {
  const client = forTenant(tenantId) as any
  return client.billing_subscription_attempts.findFirst({ where: { id: attemptId, tenant_id: tenantId } })
}

async function findOpenSubscription(tenantId: string): Promise<any | null> {
  const client = forTenant(tenantId) as any
  return client.billing_subscriptions.findFirst({
    where: { tenant_id: tenantId, status: { in: OPEN_STATUSES } },
    orderBy: { updated_at: 'desc' },
  })
}

async function resumeUnpaidCreatedSubscription(
  tenantId: string,
  subscription: any,
  input: CreateSubscriptionInput,
  region: BillingRegion,
): Promise<any | null> {
  const isSameUnpaidCheckout = subscription.status === 'created'
    && subscription.entitlement_status === 'blocked'
    && !subscription.last_payment_id
    && subscription.plan_key === input.planKey
    && subscription.billing_cycle === input.billingCycle
    && subscription.region === region
    && typeof subscription.attempt_id === 'string'
    && typeof subscription.provider_subscription_id === 'string'

  if (!isSameUnpaidCheckout) return null

  const attempt = await findAttempt(tenantId, subscription.attempt_id)
  if (!attempt || attempt.provider_subscription_id !== subscription.provider_subscription_id) return null

  let provider: RazorpaySubscription
  try {
    provider = await fetchRazorpaySubscription(subscription.provider_subscription_id)
  } catch {
    throw new BillingHttpError(503, 'We could not check your unfinished payment. Please retry in a moment.')
  }

  // Creating a Razorpay Subscription is not a successful payment. While it
  // remains `created`, Checkout can safely be opened again with the original
  // provider subscription and attempt IDs, even if the browser lost its old
  // sessionStorage idempotency key after navigating away or closing the tab.
  if (provider.status !== 'created' || provider.plan_id !== attempt.provider_plan_id) return null

  return subscriptionResponse(attempt, region)
}

async function supersedeUnpaidCreatedSubscription(
  tenantId: string,
  subscription: any,
  input: CreateSubscriptionInput,
  region: BillingRegion,
): Promise<any | null> {
  const isUnpaidCheckout = subscription.status === 'created'
    && subscription.entitlement_status === 'blocked'
    && !subscription.last_payment_id
    && subscription.region === region
    && typeof subscription.attempt_id === 'string'
    && typeof subscription.provider_subscription_id === 'string'

  if (!isUnpaidCheckout) return null
  if (subscription.plan_key === input.planKey && subscription.billing_cycle === input.billingCycle) return null

  const attempt = await findAttempt(tenantId, subscription.attempt_id)
  if (!attempt || attempt.provider_subscription_id !== subscription.provider_subscription_id) return null

  let provider: RazorpaySubscription
  try {
    provider = await fetchRazorpaySubscription(subscription.provider_subscription_id)
  } catch {
    throw new BillingHttpError(503, 'We could not check your unfinished payment. Please retry in a moment.')
  }

  if (provider.plan_id !== attempt.provider_plan_id) {
    throw new BillingHttpError(409, 'The unfinished payment does not match its recorded Razorpay plan. Contact support before retrying.')
  }

  const client = forTenant(tenantId) as any
  if (provider.status === 'cancelled' || provider.status === 'expired' || provider.status === 'completed') {
    await client.billing_subscription_attempts.update({
      where: { id: attempt.id },
      data: { status: 'expired', provider_payload: provider },
    })
    await client.billing_subscriptions.update({
      where: { id: subscription.id },
      data: {
        status: provider.status,
        entitlement_status: 'blocked',
        provider_payload: provider,
        ...providerSnapshotDates(provider),
      },
    })
    return provider
  }

  if (provider.status === 'active' || provider.status === 'authenticated'
    || provider.status === 'pending' || provider.status === 'halted') {
    await client.billing_subscription_attempts.update({
      where: { id: attempt.id },
      data: {
        status: provider.status === 'active' ? 'active' : 'verification_pending',
        provider_payload: provider,
      },
    })
    await client.billing_subscriptions.update({
      where: { id: subscription.id },
      data: {
        status: provider.status,
        entitlement_status: provider.status === 'active' ? 'active' : 'blocked',
        provider_payload: provider,
        ...providerSnapshotDates(provider),
      },
    })
    throw new BillingHttpError(
      409,
      provider.status === 'active'
        ? 'Your previous payment is active. Refresh the page to continue with that subscription.'
        : 'Your previous payment is being confirmed by Razorpay. Refresh shortly before choosing another plan.',
    )
  }

  if (provider.status !== 'created') {
    throw new BillingHttpError(409, 'Razorpay returned an unknown status for the unfinished payment. Contact support before retrying.')
  }

  let cancelled: RazorpaySubscription
  try {
    cancelled = await cancelRazorpaySubscription(subscription.provider_subscription_id, false)
  } catch {
    throw new BillingHttpError(502, 'Razorpay could not cancel the unfinished payment. Please retry before choosing another plan.')
  }

  await client.billing_subscription_attempts.update({
    where: { id: attempt.id },
    data: {
      status: 'expired',
      failure_code: 'superseded',
      failure_message: `Superseded by ${input.planKey} ${input.billingCycle} checkout`,
      provider_payload: cancelled,
    },
  })
  await client.billing_subscriptions.update({
    where: { id: subscription.id },
    data: {
      status: 'cancelled',
      entitlement_status: 'blocked',
      cancel_at_cycle_end: false,
      provider_payload: cancelled,
      ...providerSnapshotDates(cancelled),
    },
  })
  return cancelled
}

function amount(value: unknown): number {
  return Number(value ?? 0)
}

function dateOrNull(value: unknown): Date | null {
  return value instanceof Date ? value : null
}

function providerSnapshotDates(provider: RazorpaySubscription) {
  return {
    current_start_at: unixSecondsToDate(provider.current_start),
    current_end_at: unixSecondsToDate(provider.current_end ?? provider.charge_at),
  }
}

function statusPayload(row: any) {
  const access = subscriptionAccessForRow(row)
  return {
    hasSubscription: Boolean(row),
    entitlement: access.entitlement,
    accessAllowed: access.accessAllowed,
    graceUntil: access.graceUntil?.toISOString() ?? null,
    subscription: row
      ? {
          id: row.id,
          providerSubscriptionId: row.provider_subscription_id,
          planKey: row.plan_key,
          billingCycle: row.billing_cycle,
          currency: row.currency,
          status: row.status,
          cancelAtCycleEnd: Boolean(row.cancel_at_cycle_end),
          currentEndAt: dateOrNull(row.current_end_at)?.toISOString() ?? null,
          lastPaymentId: row.last_payment_id ?? null,
          lastInvoiceId: row.last_invoice_id ?? null,
        }
      : null,
  }
}

export async function getBillingStatus(tenantId: string) {
  // This middleware runs on nearly every authenticated request. Keep the
  // read and possible grace-expiry write in one short transaction so a single
  // request acquires one connection, not one transaction per model operation.
  return forTenantTransaction(tenantId, async (tx) => {
    const row = await tx.billing_subscriptions.findFirst({
      where: { tenant_id: tenantId, status: { in: OPEN_STATUSES } },
      orderBy: { updated_at: 'desc' },
    })
    const access = subscriptionAccessForRow(row)
    if (row && row.entitlement_status === 'grace' && !access.accessAllowed) {
      await tx.billing_subscriptions.update({
        where: { id: row.id },
        data: { entitlement_status: 'blocked' },
      })
      row.entitlement_status = 'blocked'
      row.grace_until_at = null
    }
    return statusPayload(row)
  })
}

function subscriptionResponse(attempt: any, region: BillingRegion) {
  const config = getRazorpayConfig()
  return {
    attemptId: attempt.id,
    razorpayKeyId: config.keyId,
    razorpaySubscriptionId: attempt.provider_subscription_id,
    status: attempt.status,
    region,
    planKey: attempt.plan_key,
    billingCycle: attempt.billing_cycle,
    currency: attempt.currency,
    quote: {
      baseAmountMinor: amount(attempt.base_amount_minor),
      taxAmountMinor: amount(attempt.tax_amount_minor),
      totalAmountMinor: amount(attempt.total_amount_minor),
      taxRateBps: attempt.tax_rate_bps,
      taxMode: region === 'IN' ? 'included' : 'exclusive',
      taxLabel: region === 'IN'
        ? `GST (${(attempt.tax_rate_bps / 100).toFixed(0)}% included)`
        : attempt.tax_rate_bps > 0
          ? `Estimated tax (${(attempt.tax_rate_bps / 100).toFixed(2)}%)`
          : 'Tax calculated according to your tax settings',
    },
  }
}

async function projectSubscription(tenantId: string, attempt: any, provider: RazorpaySubscription): Promise<any> {
  const client = forTenant(tenantId) as any
  return client.billing_subscriptions.upsert({
    where: { provider_subscription_id: provider.id },
    create: {
      tenant_id: tenantId,
      attempt_id: attempt.id,
      provider_subscription_id: provider.id,
      provider_plan_id: attempt.provider_plan_id,
      region: attempt.region,
      plan_key: attempt.plan_key,
      billing_cycle: attempt.billing_cycle,
      currency: attempt.currency,
      base_amount_minor: attempt.base_amount_minor,
      tax_amount_minor: attempt.tax_amount_minor,
      total_amount_minor: attempt.total_amount_minor,
      tax_rate_bps: attempt.tax_rate_bps,
      // Denormalised from the catalog at purchase time (0053). An owner who
      // bought a 3-shop plan keeps 3 shops even if that tier is later
      // redefined — repricing an existing customer by editing a config file
      // should not be possible by accident.
      included_store_count: includedStoresForPlan(attempt.plan_key, attempt.region),
      additional_store_count: 0,
      additional_register_count: 0,
      additional_user_count: 0,
      status: provider.status === 'active' ? 'active' : 'created',
      entitlement_status: provider.status === 'active' ? 'active' : 'blocked',
      ...providerSnapshotDates(provider),
      provider_payload: provider,
    },
    update: {
      attempt_id: attempt.id,
      // Previously omitted here: an existing row's status/entitlement could
      // only ever be set at creation, never re-synced afterward. Any
      // reconciliation call for an existing subscription (this function is
      // the only writer besides verifySubscription's own explicit update)
      // would silently keep re-confirming whatever status the row was
      // created with, even once Razorpay reports something different.
      status: provider.status === 'active' ? 'active' : 'created',
      entitlement_status: provider.status === 'active' ? 'active' : 'blocked',
      provider_payload: provider,
      ...providerSnapshotDates(provider),
    },
  })
}

async function adoptProviderSubscription(tenantId: string, attempt: any, provider: RazorpaySubscription): Promise<any> {
  const client = forTenant(tenantId) as any
  const updatedAttempt = await client.billing_subscription_attempts.update({
    where: { id: attempt.id },
    data: {
      provider_subscription_id: provider.id,
      status: provider.status === 'active' ? 'active' : 'created',
      provider_payload: provider,
      failure_code: null,
      failure_message: null,
    },
  })
  await projectSubscription(tenantId, updatedAttempt, provider)
  return updatedAttempt
}

async function reconcileAttempt(tenantId: string, attempt: any): Promise<any | null> {
  if (attempt.provider_subscription_id) return attempt
  let provider: RazorpaySubscription | null
  try {
    provider = await findRazorpaySubscriptionByAttemptId(attempt.id)
  } catch {
    throw new BillingHttpError(503, 'We are checking whether the payment provider already created this subscription. Retry in a moment.')
  }
  return provider ? adoptProviderSubscription(tenantId, attempt, provider) : null
}

export async function createSubscription(tenantId: string, input: CreateSubscriptionInput) {
  const region = await tenantRegion(tenantId)
  const plan = getPlan(region, input.planKey)
  if (!plan) throw new BillingHttpError(400, 'That plan is not available for this account region')
  const planProviderId = providerPlanId(plan, input.billingCycle)
  if (!planProviderId) throw new BillingHttpError(503, 'This test plan is not connected to a Razorpay Plan ID yet')
  const quote = calculateQuote(plan, input.billingCycle)
  try {
    const providerPlan = await fetchRazorpayPlan(planProviderId)
    if (providerPlan.item?.amount !== quote.totalAmountMinor || providerPlan.item?.currency !== plan.currency) {
      throw new BillingHttpError(503, 'The Razorpay Plan amount or currency does not match the current backend catalog')
    }
  } catch (error) {
    if (error instanceof BillingHttpError) throw error
    throw new BillingHttpError(503, 'The Razorpay Plan could not be validated for this subscription')
  }
  const client = forTenant(tenantId) as any
  let attempt: any
  // Look up the idempotency row before checking for an open subscription. A
  // user who closed Checkout must be able to reopen the exact same provider
  // subscription. The recovery below also handles a browser that lost the
  // original key, but only for the same unpaid plan and billing cycle.
  attempt = await client.billing_subscription_attempts.findFirst({
    where: { tenant_id: tenantId, idempotency_key: input.idempotencyKey },
  })
  if (!attempt) {
    const existingOpen = await findOpenSubscription(tenantId)
    if (existingOpen) {
      const resumed = await resumeUnpaidCreatedSubscription(tenantId, existingOpen, input, region)
      if (resumed) return resumed
      const superseded = await supersedeUnpaidCreatedSubscription(tenantId, existingOpen, input, region)
      // Once superseded, the old Razorpay Checkout URL is invalid and the
      // partial unique index no longer considers its projection open. Continue
      // with the newly selected plan using this request's idempotency key.
      if (!superseded && existingOpen.status === 'created'
        && existingOpen.entitlement_status === 'blocked'
        && !existingOpen.last_payment_id) {
        throw new BillingHttpError(
          409,
          `An unfinished ${existingOpen.plan_key} ${existingOpen.billing_cycle} payment exists. Select that plan to resume checkout.`,
        )
      }
      if (!superseded) {
        throw new BillingHttpError(409, 'This account already has a subscription. Plan changes will be available from a future billing cycle.')
      }
    }
  }
  try {
    if (!attempt) {
      attempt = await client.billing_subscription_attempts.create({
        data: {
          tenant_id: tenantId,
          idempotency_key: input.idempotencyKey,
          region,
          plan_key: plan.key,
          billing_cycle: input.billingCycle,
          currency: plan.currency,
          base_amount_minor: BigInt(quote.baseAmountMinor),
          tax_amount_minor: BigInt(quote.taxAmountMinor),
          total_amount_minor: BigInt(quote.totalAmountMinor),
          tax_rate_bps: quote.taxRateBps,
          provider_plan_id: planProviderId,
          status: 'creating',
        },
      })
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    attempt = await client.billing_subscription_attempts.findFirst({
      where: { tenant_id: tenantId, idempotency_key: input.idempotencyKey },
    })
    if (!attempt) throw error
  }

  if (attempt.provider_subscription_id) {
    // A retry must re-check Razorpay, not echo attempt.status back at
    // itself. If Checkout's success callback never reached /verify (tab
    // closed, chunk-load error, network drop right after a real charge),
    // attempt.status is permanently stuck at 'created' — a synthetic
    // provider object built from that field would keep re-confirming
    // "unpaid" forever even after the customer has actually been charged.
    let provider: RazorpaySubscription
    try {
      provider = await fetchRazorpaySubscription(attempt.provider_subscription_id)
    } catch {
      // Razorpay is unreachable right now for what's otherwise a known,
      // already-created attempt — surface the last state we have instead of
      // failing the request outright. The next retry re-checks Razorpay.
      await projectSubscription(tenantId, attempt, {
        id: attempt.provider_subscription_id,
        plan_id: attempt.provider_plan_id,
        status: attempt.status === 'active' ? 'active' : 'created',
      })
      return subscriptionResponse(attempt, region)
    }
    const updatedAttempt = await adoptProviderSubscription(tenantId, attempt, provider)
    return subscriptionResponse(updatedAttempt, region)
  }
  if (attempt.status === 'failed' || attempt.status === 'expired') {
    throw new BillingHttpError(409, 'This payment attempt has ended. Start a new attempt to retry the subscription.')
  }

  const reconciled = await reconcileAttempt(tenantId, attempt)
  if (reconciled?.provider_subscription_id) return subscriptionResponse(reconciled, region)

  let provider: RazorpaySubscription
  try {
    provider = await createRazorpaySubscription({
      planId: planProviderId,
      billingCycle: input.billingCycle,
      notes: {
        tenant_id: tenantId,
        billing_attempt_id: attempt.id,
        plan_key: plan.key,
        region,
        billing_cycle: input.billingCycle,
      },
    })
  } catch (error) {
    if (error instanceof RazorpayRequestError) {
      await client.billing_subscription_attempts.update({
        where: { id: attempt.id },
        data: { status: 'failed', failure_code: String(error.providerStatus), failure_message: error.message },
      })
      throw new BillingHttpError(502, 'Razorpay could not start this subscription. Check the plan configuration and try again.')
    }
    // A transport error is deliberately left as `creating`: the next request
    // with the same idempotency key must reconcile before creating anything.
    throw new BillingHttpError(503, 'We could not confirm the payment provider response. Retry with the same payment attempt.')
  }

  const updatedAttempt = await adoptProviderSubscription(tenantId, attempt, provider)
  return subscriptionResponse(updatedAttempt, region)
}

export async function verifySubscription(tenantId: string, input: {
  attemptId: string
  razorpayPaymentId: string
  razorpaySubscriptionId: string
  razorpaySignature: string
}) {
  const attempt = await findAttempt(tenantId, input.attemptId)
  if (!attempt || attempt.provider_subscription_id !== input.razorpaySubscriptionId) {
    throw new BillingHttpError(400, 'This payment attempt does not match the subscription returned by Razorpay')
  }
  if (!verifyRazorpayCheckoutSignature({
    paymentId: input.razorpayPaymentId,
    subscriptionId: input.razorpaySubscriptionId,
    signature: input.razorpaySignature,
  })) {
    throw new BillingHttpError(400, 'Razorpay payment signature verification failed')
  }

  let provider: RazorpaySubscription
  try {
    provider = await fetchRazorpaySubscription(input.razorpaySubscriptionId)
  } catch {
    throw new BillingHttpError(503, 'Payment signature verified, but subscription status is still being confirmed. Retry shortly.')
  }

  const client = forTenant(tenantId) as any
  const status = provider.status === 'active' ? 'active' : 'verification_pending'
  await client.billing_subscription_attempts.update({
    where: { id: attempt.id },
    data: { status, provider_payload: provider },
  })
  const subscription = await client.billing_subscriptions.update({
    where: { provider_subscription_id: input.razorpaySubscriptionId },
    data: {
      status: provider.status,
      entitlement_status: provider.status === 'active' ? 'active' : 'blocked',
      last_payment_id: input.razorpayPaymentId,
      ...providerSnapshotDates(provider),
      provider_payload: provider,
    },
  })

  if (input.razorpayPaymentId) {
    try {
      await client.billing_transactions.upsert({
        where: { provider_payment_id: input.razorpayPaymentId },
        create: {
          tenant_id: tenantId,
          subscription_id: subscription.id,
          provider_payment_id: input.razorpayPaymentId,
          kind: 'charge',
          status: provider.status === 'active' ? 'captured' : 'pending',
          amount_minor: attempt.total_amount_minor,
          currency: attempt.currency,
          provider_payload: { paymentId: input.razorpayPaymentId, provider },
        },
        update: { status: provider.status === 'active' ? 'captured' : 'pending', provider_event_id: null },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }

  return statusPayload(subscription)
}

export async function cancelSubscription(tenantId: string) {
  const current = await findOpenSubscription(tenantId)
  if (!current) throw new BillingHttpError(404, 'No active subscription was found')
  if (current.cancel_at_cycle_end) return statusPayload(current)
  let provider: RazorpaySubscription
  try {
    provider = await cancelRazorpaySubscription(current.provider_subscription_id)
  } catch {
    throw new BillingHttpError(502, 'Razorpay could not schedule the cancellation. Please try again.')
  }
  const client = forTenant(tenantId) as any
  const updated = await client.billing_subscriptions.update({
    where: { id: current.id },
    data: { cancel_at_cycle_end: true, provider_payload: provider, ...providerSnapshotDates(provider) },
  })
  return statusPayload(updated)
}

function eventEntity(body: any): { subscription: RazorpaySubscription | null; payment: RazorpayPayment | null } {
  const subscriptionEntity = body?.payload?.subscription?.entity
  const paymentEntity = body?.payload?.payment?.entity
  const subscription = subscriptionEntity && typeof subscriptionEntity === 'object' ? subscriptionEntity as RazorpaySubscription : null
  const payment = paymentEntity && typeof paymentEntity === 'object' ? paymentEntity as RazorpayPayment : null
  return { subscription, payment }
}

function nextGraceDate(current: any): Date {
  return dateOrNull(current?.grace_until_at) ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
}

export async function applyWebhookEvent(input: {
  tenantId: string
  eventName: string
  providerSubscriptionId: string
  providerSubscription: RazorpaySubscription | null
  providerPayment: RazorpayPayment | null
  providerEventId: string
}) {
  return forTenantTransaction(input.tenantId, async (tx) => {
    const subscription = await tx.billing_subscriptions.findFirst({
      where: { tenant_id: input.tenantId, provider_subscription_id: input.providerSubscriptionId },
    })
    if (!subscription) return null

    const currentProviderStatus = input.providerSubscription?.status ?? subscription.status
    const status = input.eventName === 'subscription.halted' || currentProviderStatus === 'halted'
      ? 'halted'
      : input.eventName === 'subscription.cancelled' || currentProviderStatus === 'cancelled'
        ? 'cancelled'
        : input.eventName === 'subscription.completed' || currentProviderStatus === 'completed'
          ? 'completed'
          : input.eventName === 'subscription.expired' || currentProviderStatus === 'expired'
            ? 'expired'
            : input.eventName === 'subscription.pending' || currentProviderStatus === 'pending'
              ? 'pending'
              : input.eventName === 'subscription.activated' || input.eventName === 'subscription.charged' || currentProviderStatus === 'active'
                ? 'active'
                : currentProviderStatus

    const entitlementStatus = status === 'active'
      ? 'active'
      : status === 'pending'
        ? (subscription.entitlement_status === 'active' ? 'active' : 'blocked')
        : status === 'halted'
          ? 'grace'
          : 'blocked'
    const graceUntil = status === 'halted' ? nextGraceDate(subscription) : status === 'active' ? null : subscription.grace_until_at
    const provider = input.providerSubscription
    const updated = await tx.billing_subscriptions.update({
      where: { id: subscription.id },
      data: {
        status,
        entitlement_status: entitlementStatus,
        grace_until_at: graceUntil,
        ...(provider ? { provider_payload: provider, ...providerSnapshotDates(provider) } : {}),
        ...(input.providerPayment ? {
          last_payment_id: input.providerPayment.id,
          last_invoice_id: input.providerPayment.invoice_id ?? null,
        } : {}),
      },
    })

    const attempt = subscription.attempt_id
      ? await tx.billing_subscription_attempts.findFirst({ where: { id: subscription.attempt_id, tenant_id: input.tenantId } })
      : null
    if (attempt) {
      await tx.billing_subscription_attempts.update({
        where: { id: attempt.id },
        data: { status: status === 'active' ? 'active' : status === 'halted' || status === 'pending' ? 'verification_pending' : attempt.status },
      })
    }

    if (input.providerPayment) {
      try {
        await tx.billing_transactions.upsert({
          where: { provider_payment_id: input.providerPayment.id },
          create: {
            tenant_id: input.tenantId,
            subscription_id: subscription.id,
            provider_payment_id: input.providerPayment.id,
            provider_invoice_id: input.providerPayment.invoice_id ?? undefined,
            provider_event_id: input.providerEventId,
            kind: 'charge',
            status: input.providerPayment.status ?? (status === 'active' ? 'captured' : 'pending'),
            amount_minor: BigInt(input.providerPayment.amount ?? amount(subscription.total_amount_minor)),
            currency: input.providerPayment.currency ?? subscription.currency,
            provider_payload: input.providerPayment,
          },
          update: {
            provider_invoice_id: input.providerPayment.invoice_id ?? undefined,
            provider_event_id: input.providerEventId,
            status: input.providerPayment.status ?? (status === 'active' ? 'captured' : 'pending'),
            provider_payload: input.providerPayment,
          },
        })
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    return updated
  })
}

export function webhookTarget(body: any): {
  tenantId: string | null
  attemptId: string | null
  providerSubscriptionId: string | null
  providerSubscription: RazorpaySubscription | null
  providerPayment: RazorpayPayment | null
} {
  const entities = eventEntity(body)
  const paymentNotes = entities.payment && typeof (entities.payment as any).notes === 'object'
    ? (entities.payment as any).notes as Record<string, string>
    : {}
  const notes = entities.subscription?.notes ?? paymentNotes
  const tenantId = typeof notes.tenant_id === 'string' ? notes.tenant_id : null
  const attemptId = typeof notes.billing_attempt_id === 'string' ? notes.billing_attempt_id : null
  const providerSubscriptionId = entities.subscription?.id
    ?? entities.payment?.subscription_id
    ?? null
  return {
    tenantId,
    attemptId,
    providerSubscriptionId,
    providerSubscription: entities.subscription,
    providerPayment: entities.payment,
  }
}

export function billingMode() {
  return getBillingMode()
}

export function planForRegion(region: BillingRegion, planKey: string, billingCycle: BillingCycle): { plan: BillingPlanDefinition; quote: ReturnType<typeof calculateQuote> } {
  const plan = getPlan(region, planKey)
  if (!plan) throw new BillingHttpError(400, 'That plan is not available')
  return { plan, quote: calculateQuote(plan, billingCycle) }
}

export function planPeriod(plan: BillingPlanDefinition, cycle: BillingCycle) {
  return getPeriod(plan, cycle)
}
