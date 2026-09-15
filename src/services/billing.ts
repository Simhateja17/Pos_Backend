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
  type BillingQuote,
  type BillingEntitlementLimits,
} from './billingCatalog'
import { getEntitlementSummary, snapshotForPlan } from './entitlements'
import {
  cancelRazorpaySubscription,
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  fetchRazorpayPlan,
  findRazorpaySubscriptionByAttemptId,
  listRazorpayInvoices,
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
    where: { tenant_id: tenantId, status: { in: OPEN_STATUSES }, switch_pending: false },
    orderBy: { updated_at: 'desc' },
  })
}

async function findPendingSwitch(tenantId: string): Promise<any | null> {
  const client = forTenant(tenantId) as any
  return client.billing_subscriptions.findFirst({
    where: { tenant_id: tenantId, status: { in: OPEN_STATUSES }, switch_pending: true },
    orderBy: { updated_at: 'desc' },
  })
}

type PrivateOfferRow = {
  id: string
  tenant_id: string
  region: string
  base_plan_key: string
  billing_cycle: 'monthly' | 'annual'
  currency: 'INR' | 'USD'
  negotiated_base_amount_minor: bigint | number
  tax_amount_minor: bigint | number
  total_amount_minor: bigint | number
  tax_rate_bps: number
  included_location_count: number
  included_register_count: number
  included_user_count: number
  provider_plan_id: string
  provider_mode: string
  latest_activation_at: Date
  status: string
}

async function privateOfferForCheckout(tenantId: string, offerId?: string): Promise<PrivateOfferRow | null> {
  if (!offerId) return null
  const rows = await forTenantTransaction<PrivateOfferRow[]>(tenantId, (tx) => tx.$queryRaw<PrivateOfferRow[]>`
      SELECT * FROM public.private_billing_offers
      WHERE id = ${offerId}::uuid AND tenant_id = ${tenantId}::uuid
      LIMIT 1
    `)
  const offer = rows[0] ?? null
  if (!offer || offer.status !== 'offered' || new Date(offer.latest_activation_at).getTime() <= Date.now()) {
    throw new BillingHttpError(409, 'This private offer is no longer available')
  }
  if (offer.provider_mode !== getBillingMode()) throw new BillingHttpError(409, 'This offer belongs to a different Razorpay mode')
  return offer
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
    && (subscription.private_offer_id ?? null) === (input.privateOfferId ?? null)
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
  if (subscription.plan_key === input.planKey && subscription.billing_cycle === input.billingCycle
    && (subscription.private_offer_id ?? null) === (input.privateOfferId ?? null)) return null

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

function projectedProviderStatus(provider: RazorpaySubscription): string {
  return ['created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired']
    .includes(provider.status)
    ? provider.status
    : 'created'
}

function statusPayload(row: any, pending: any = null) {
  const access = subscriptionAccessForRow(row)
  return {
    pendingChange: pending ? pendingChangePayload(pending) : null,
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
      where: { tenant_id: tenantId, status: { in: OPEN_STATUSES }, switch_pending: false },
      orderBy: { updated_at: 'desc' },
    })
    const pending = await tx.billing_subscriptions.findFirst({
      where: { tenant_id: tenantId, status: { in: OPEN_STATUSES }, switch_pending: true },
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
    return statusPayload(row, pending)
  })
}

function subscriptionResponse(attempt: any, region: BillingRegion) {
  const config = getRazorpayConfig()
  return {
    attemptId: attempt.id,
    razorpayKeyId: config.keyId,
    razorpaySubscriptionId: attempt.provider_subscription_id,
    // Hosted authorisation page for clients that cannot embed Checkout (mobile).
    checkoutUrl: typeof attempt.provider_payload?.short_url === 'string' && attempt.provider_payload.short_url
      ? attempt.provider_payload.short_url as string
      : null,
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
  const providerStatus = projectedProviderStatus(provider)
  const privateOffer = attempt.private_offer ?? await privateOfferForCheckout(tenantId, attempt.private_offer_id ?? undefined).catch(() => null)
  const baseSnapshot = privateOffer ? snapshotForPlan(attempt.region, attempt.plan_key) : null
  return client.billing_subscriptions.upsert({
    where: { provider_subscription_id: provider.id },
    create: {
      tenant_id: tenantId,
      attempt_id: attempt.id,
      provider_subscription_id: provider.id,
      provider_plan_id: attempt.provider_plan_id,
      private_offer_id: attempt.private_offer_id ?? null,
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
      included_store_count: privateOffer?.included_location_count ?? includedStoresForPlan(attempt.plan_key, attempt.region),
      entitlement_snapshot: privateOffer && baseSnapshot ? {
        ...baseSnapshot,
        limits: {
          ...baseSnapshot.limits,
          maxLocations: privateOffer.included_location_count,
          maxActiveRegisters: privateOffer.included_register_count,
          maxActiveUsers: privateOffer.included_user_count,
        },
      } : undefined,
      additional_store_count: 0,
      additional_register_count: 0,
      additional_user_count: 0,
      status: providerStatus,
      entitlement_status: providerStatus === 'active' ? 'active' : 'blocked',
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
      status: providerStatus,
      entitlement_status: providerStatus === 'active' ? 'active' : 'blocked',
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
  const privateOffer = await privateOfferForCheckout(tenantId, input.privateOfferId)
  const requestedPlanKey = privateOffer?.base_plan_key ?? input.planKey
  if (privateOffer && (privateOffer.billing_cycle !== input.billingCycle || privateOffer.region !== region || privateOffer.base_plan_key !== input.planKey)) {
    throw new BillingHttpError(400, 'The selected plan or billing cycle does not match this private offer')
  }
  const plan = getPlan(region, requestedPlanKey)
  if (!plan) throw new BillingHttpError(400, 'That plan is not available for this account region')
  const planProviderId = privateOffer?.provider_plan_id ?? providerPlanId(plan, input.billingCycle)
  if (!planProviderId) throw new BillingHttpError(503, 'This test plan is not connected to a Razorpay Plan ID yet')
  const quote: BillingQuote = privateOffer ? {
    baseAmountMinor: amount(privateOffer.negotiated_base_amount_minor),
    taxAmountMinor: amount(privateOffer.tax_amount_minor),
    totalAmountMinor: amount(privateOffer.total_amount_minor),
    taxRateBps: privateOffer.tax_rate_bps,
    taxMode: 'exclusive',
    taxLabel: privateOffer.tax_rate_bps > 0 ? `GST (${(privateOffer.tax_rate_bps / 100).toFixed(0)}%)` : 'No tax',
  } : calculateQuote(plan, input.billingCycle)
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
          private_offer_id: privateOffer?.id ?? null,
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
    if (provider.status === 'cancelled' || provider.status === 'completed' || provider.status === 'expired') {
      const endedAttempt = await client.billing_subscription_attempts.update({
        where: { id: attempt.id },
        data: { status: 'expired', provider_payload: provider },
      })
      await projectSubscription(tenantId, endedAttempt, provider)
      throw new BillingHttpError(409, 'This payment attempt has ended. Start a new attempt to retry the subscription.')
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

  if (privateOffer) attempt.private_offer = privateOffer
  const updatedAttempt = await adoptProviderSubscription(tenantId, attempt, provider)
  if (privateOffer) updatedAttempt.private_offer = privateOffer
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
  if (provider.status === 'active' && attempt.private_offer_id) {
    await forTenantTransaction(tenantId, async (tx) => {
      await tx.$executeRaw`UPDATE public.private_billing_offers SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = ${attempt.private_offer_id}::uuid AND tenant_id = ${tenantId}::uuid AND status = 'offered'`
      await tx.$executeRaw`UPDATE public.billing_trials SET status = 'cancelled', updated_at = now() WHERE tenant_id = ${tenantId}::uuid AND status IN ('pending', 'active')`
    })
  }

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

  if (attempt.replaces_subscription_id) {
    await reconcilePlanSwitch(tenantId, subscription)
    return getBillingStatus(tenantId)
  }
  return statusPayload(subscription)
}

export async function cancelSubscription(tenantId: string) {
  const current = await findOpenSubscription(tenantId)
  if (!current) throw new BillingHttpError(404, 'No active subscription was found')
  // A scheduled successor has not charged yet. Ending the plan must end it too,
  // or the new mandate would start billing after the owner cancelled.
  const pending = await findPendingSwitch(tenantId)
  if (pending) await discardSuccessor(tenantId, pending)
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

async function applyWebhookEventRow(input: {
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
      : status === 'authenticated' && subscription.entitlement_status === 'grace'
        ? 'grace'
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

export async function applyWebhookEvent(input: Parameters<typeof applyWebhookEventRow>[0]) {
  const updated = await applyWebhookEventRow(input)
  if (updated) {
    try {
      await reconcilePlanSwitch(input.tenantId, updated)
    } catch (error) {
      // The event itself is recorded. The owner's next billing-page load
      // reconciles the switch again, so a transient provider error is not lost.
      console.error('[billing] plan switch reconciliation deferred', error)
    }
  }
  return updated
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


/* ---------- plan changes ---------- */
//
// Razorpay cannot change the plan of a UPI Autopay or eMandate subscription, so
// every plan change is a new provider subscription the owner authorises. The
// new row is `switch_pending` (never read as the live entitlement) until it is
// promoted:
//   upgrade            → charged now; the old subscription is cancelled at once
//                        (no refund for unused days).
//   downgrade/renewal  → authorised now, first charge when the current period
//                        ends; the old subscription is set to end at cycle end.

type SwitchKind = 'upgrade' | 'downgrade' | 'renewal'

export type ChangeSubscriptionInput = {
  planKey: string
  billingCycle: BillingCycle
  idempotencyKey: string
}

// Authorised but not yet charged: keep the shop open while Razorpay collects.
const SWITCH_GRACE_MS = 2 * 24 * 60 * 60 * 1000
const ENDED_STATUSES = ['cancelled', 'completed', 'expired']

function timestampOrNull(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function unixIso(value: unknown): string | null {
  return unixSecondsToDate(value)?.toISOString() ?? null
}

function pendingChangePayload(row: any) {
  return {
    id: row.id,
    kind: (row.switch_kind ?? 'upgrade') as SwitchKind,
    planKey: row.plan_key,
    billingCycle: row.billing_cycle,
    status: row.status,
    authorised: row.status !== 'created',
    startsAt: timestampOrNull(row.switch_starts_at)?.toISOString() ?? null,
    totalAmountMinor: amount(row.total_amount_minor),
    currency: row.currency,
  }
}

function monthlyEquivalentMinor(totalMinor: number, cycle: string): number {
  return cycle === 'annual' ? totalMinor / 12 : totalMinor
}

function downgradeBlockers(
  limits: BillingEntitlementLimits,
  usage: { locations?: number; activeUsers?: number; activeRegisters?: number },
): string[] {
  const checks: Array<[string, BillingEntitlementLimits[keyof BillingEntitlementLimits], number]> = [
    ['locations', limits.maxLocations, Number(usage.locations ?? 0)],
    ['active users', limits.maxActiveUsers, Number(usage.activeUsers ?? 0)],
    ['active registers', limits.maxActiveRegisters, Number(usage.activeRegisters ?? 0)],
  ]
  return checks
    .filter(([, limit, used]) => typeof limit === 'number' && used > limit)
    .map(([label, limit, used]) => `${used} ${label} (plan allows ${limit})`)
}

function changeResponse(attempt: any, row: any, region: BillingRegion) {
  const payload = row.provider_payload as RazorpaySubscription | null
  return {
    ...subscriptionResponse(attempt, region),
    kind: (row.switch_kind ?? attempt.switch_kind ?? 'upgrade') as SwitchKind,
    startsAt: timestampOrNull(row.switch_starts_at)?.toISOString() ?? null,
    checkoutUrl: typeof payload?.short_url === 'string' && payload.short_url ? payload.short_url : null,
  }
}

export async function changeSubscription(tenantId: string, input: ChangeSubscriptionInput) {
  const region = await tenantRegion(tenantId)
  const plan = getPlan(region, input.planKey)
  if (!plan) throw new BillingHttpError(400, 'That plan is not available for this account region')
  const planProviderId = providerPlanId(plan, input.billingCycle)
  if (!planProviderId) throw new BillingHttpError(503, 'This plan is not connected to a Razorpay Plan ID yet')
  const client = forTenant(tenantId) as any

  // A retried request returns the checkout it already created.
  const existingAttempt = await client.billing_subscription_attempts.findFirst({
    where: { tenant_id: tenantId, idempotency_key: input.idempotencyKey },
  })
  if (existingAttempt?.provider_subscription_id) {
    const row = await client.billing_subscriptions.findFirst({
      where: { tenant_id: tenantId, provider_subscription_id: existingAttempt.provider_subscription_id },
    })
    if (row) return changeResponse(existingAttempt, row, region)
  }
  if (existingAttempt && existingAttempt.status !== 'creating') {
    throw new BillingHttpError(409, 'This plan change attempt has ended. Start again to choose a plan.')
  }

  const current = await findOpenSubscription(tenantId)
  if (!current || !['active', 'authenticated', 'pending', 'halted'].includes(current.status)) {
    throw new BillingHttpError(409, 'There is no active subscription to change. Choose a plan to subscribe instead.')
  }
  if (current.plan_key === plan.key && current.billing_cycle === input.billingCycle && !current.cancel_at_cycle_end) {
    throw new BillingHttpError(409, 'You are already on this plan and billing cycle.')
  }

  const pending = await findPendingSwitch(tenantId)
  if (pending) {
    if (pending.status === 'created' && pending.plan_key === plan.key && pending.billing_cycle === input.billingCycle && pending.attempt_id) {
      const attempt = await findAttempt(tenantId, pending.attempt_id)
      if (attempt) return changeResponse(attempt, pending, region)
    }
    throw new BillingHttpError(409, pending.status === 'created'
      ? `An unfinished change to ${pending.plan_key} (${pending.billing_cycle}) is waiting for authorisation. Discard it before choosing another plan.`
      : `A change to ${pending.plan_key} (${pending.billing_cycle}) is already scheduled.`)
  }

  const quote = calculateQuote(plan, input.billingCycle)
  try {
    const providerPlan = await fetchRazorpayPlan(planProviderId)
    if (providerPlan.item?.amount !== quote.totalAmountMinor || providerPlan.item?.currency !== plan.currency) {
      throw new BillingHttpError(503, 'The Razorpay Plan amount or currency does not match the current backend catalog')
    }
  } catch (error) {
    if (error instanceof BillingHttpError) throw error
    throw new BillingHttpError(503, 'The Razorpay Plan could not be validated for this change')
  }

  const kind: SwitchKind = current.cancel_at_cycle_end
    ? 'renewal'
    : monthlyEquivalentMinor(quote.totalAmountMinor, input.billingCycle) > monthlyEquivalentMinor(amount(current.total_amount_minor), current.billing_cycle)
      ? 'upgrade'
      : 'downgrade'

  if (kind !== 'upgrade') {
    const summary = await getEntitlementSummary(tenantId)
    const blockers = downgradeBlockers(plan.entitlements, summary.usage)
    if (blockers.length) {
      throw new BillingHttpError(409, `The ${plan.name} plan does not cover what this business uses today: ${blockers.join(', ')}. Deactivate the extra before switching.`)
    }
  }

  const periodEnd = timestampOrNull(current.current_end_at)
  // Razorpay needs a start time in the future; without one the change applies now.
  const startsAt = kind !== 'upgrade' && periodEnd && periodEnd.getTime() > Date.now() + 5 * 60_000 ? periodEnd : null

  let attempt = existingAttempt
  if (!attempt) {
    try {
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
          replaces_subscription_id: current.id,
          switch_kind: kind,
          status: 'creating',
        },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      throw new BillingHttpError(409, 'This plan change is already being started. Refresh and try again.')
    }
  }

  let provider: RazorpaySubscription | null = null
  if (existingAttempt) {
    // A transport error left this attempt in `creating`; adopt what Razorpay made.
    try {
      provider = await findRazorpaySubscriptionByAttemptId(attempt.id)
    } catch {
      throw new BillingHttpError(503, 'We are checking whether Razorpay already created this change. Retry in a moment.')
    }
  }
  if (!provider) {
    try {
      provider = await createRazorpaySubscription({
        planId: planProviderId,
        billingCycle: input.billingCycle,
        startAt: startsAt ? Math.floor(startsAt.getTime() / 1000) : undefined,
        notes: {
          tenant_id: tenantId,
          billing_attempt_id: attempt.id,
          plan_key: plan.key,
          region,
          billing_cycle: input.billingCycle,
          switch_kind: kind,
          replaces_subscription_id: current.id,
        },
      })
    } catch (error) {
      if (error instanceof RazorpayRequestError) {
        await client.billing_subscription_attempts.update({
          where: { id: attempt.id },
          data: { status: 'failed', failure_code: String(error.providerStatus), failure_message: error.message },
        })
        throw new BillingHttpError(502, 'Razorpay could not start this plan change. Please try again.')
      }
      throw new BillingHttpError(503, 'We could not confirm the payment provider response. Retry with the same attempt.')
    }
  }

  const updatedAttempt = await client.billing_subscription_attempts.update({
    where: { id: attempt.id },
    data: { provider_subscription_id: provider.id, status: 'created', provider_payload: provider },
  })
  const row = await client.billing_subscriptions.create({
    data: {
      tenant_id: tenantId,
      attempt_id: attempt.id,
      provider_subscription_id: provider.id,
      provider_plan_id: planProviderId,
      region,
      plan_key: plan.key,
      billing_cycle: input.billingCycle,
      currency: plan.currency,
      base_amount_minor: BigInt(quote.baseAmountMinor),
      tax_amount_minor: BigInt(quote.taxAmountMinor),
      total_amount_minor: BigInt(quote.totalAmountMinor),
      tax_rate_bps: quote.taxRateBps,
      included_store_count: includedStoresForPlan(plan.key, region),
      additional_store_count: 0,
      additional_register_count: 0,
      additional_user_count: 0,
      status: projectedProviderStatus(provider),
      entitlement_status: 'blocked',
      replaces_subscription_id: current.id,
      switch_kind: kind,
      switch_pending: true,
      switch_starts_at: startsAt,
      provider_payload: provider,
      ...providerSnapshotDates(provider),
    },
  })
  return changeResponse(updatedAttempt, row, region)
}

async function discardSuccessor(tenantId: string, pending: any) {
  try {
    await cancelRazorpaySubscription(pending.provider_subscription_id, false)
  } catch {
    const provider = await fetchRazorpaySubscription(pending.provider_subscription_id).catch(() => null)
    if (!provider || !ENDED_STATUSES.includes(provider.status)) {
      throw new BillingHttpError(502, 'Razorpay could not discard the pending plan change. Please try again.')
    }
  }
  const client = forTenant(tenantId) as any
  await client.billing_subscriptions.update({
    where: { id: pending.id },
    data: { status: 'cancelled', entitlement_status: 'blocked' },
  })
  if (pending.attempt_id) {
    await client.billing_subscription_attempts.update({ where: { id: pending.attempt_id }, data: { status: 'expired' } })
  }
}

export async function cancelPendingChange(tenantId: string) {
  const pending = await findPendingSwitch(tenantId)
  if (!pending) throw new BillingHttpError(404, 'There is no pending plan change')
  if (pending.status !== 'created') {
    // Authorising the change already set the current plan to end, and Razorpay
    // cannot revive a subscription scheduled for cancellation.
    throw new BillingHttpError(409, 'This change is already authorised and your current plan is set to end, so it cannot be discarded here. Contact support to undo it.')
  }
  await discardSuccessor(tenantId, pending)
  return getBillingStatus(tenantId)
}

async function promoteSuccessor(tenantId: string, old: any | null, successor: any) {
  const active = successor.status === 'active'
  await forTenantTransaction(tenantId, async (tx) => {
    // The old row must leave the open set first: one live subscription per tenant.
    if (old) {
      await tx.billing_subscriptions.update({
        where: { id: old.id },
        data: { status: 'cancelled', entitlement_status: 'blocked', grace_until_at: null },
      })
    }
    await tx.billing_subscriptions.update({
      where: { id: successor.id },
      data: {
        switch_pending: false,
        entitlement_status: active ? 'active' : 'grace',
        grace_until_at: active ? null : new Date(Date.now() + SWITCH_GRACE_MS),
      },
    })
    if (successor.attempt_id) {
      await tx.billing_subscription_attempts.update({
        where: { id: successor.attempt_id },
        data: { status: active ? 'active' : 'verification_pending' },
      })
    }
  })
}

/** Idempotent. Moves a plan change forward from whatever Razorpay last reported. */
export async function reconcilePlanSwitch(tenantId: string, row: any): Promise<void> {
  if (!row) return
  const client = forTenant(tenantId) as any

  if (!row.switch_pending) {
    // An ended subscription hands over to its authorised successor.
    if (!ENDED_STATUSES.includes(row.status)) return
    const successor = await client.billing_subscriptions.findFirst({
      where: { tenant_id: tenantId, replaces_subscription_id: row.id, switch_pending: true, status: { in: ['authenticated', 'active'] } },
    })
    if (successor) await promoteSuccessor(tenantId, null, successor)
    return
  }

  if (!['authenticated', 'active'].includes(row.status)) return
  const old = row.replaces_subscription_id
    ? await client.billing_subscriptions.findFirst({ where: { id: row.replaces_subscription_id, tenant_id: tenantId } })
    : null
  const oldOpen = Boolean(old && OPEN_STATUSES.includes(old.status))

  if (!row.switch_starts_at || row.status === 'active') {
    if (oldOpen) {
      try {
        await cancelRazorpaySubscription(old.provider_subscription_id, false)
      } catch {
        // Only proceed if the old subscription really has ended; never leave two charging.
        const provider = await fetchRazorpaySubscription(old.provider_subscription_id).catch(() => null)
        if (!provider || !ENDED_STATUSES.includes(provider.status)) {
          throw new BillingHttpError(502, 'Razorpay could not end the previous subscription. The change will retry.')
        }
      }
    }
    await promoteSuccessor(tenantId, oldOpen ? old : null, row)
    return
  }

  // Scheduled change: the owner keeps the current plan until its period ends.
  if (oldOpen && !old.cancel_at_cycle_end) {
    const provider = await cancelRazorpaySubscription(old.provider_subscription_id, true)
    await client.billing_subscriptions.update({
      where: { id: old.id },
      data: { cancel_at_cycle_end: true, provider_payload: provider, ...providerSnapshotDates(provider) },
    })
  }
  if (!oldOpen) await promoteSuccessor(tenantId, null, row)
}

/**
 * Called by the billing screens (not every request): refreshes a pending change
 * from Razorpay when it may have moved on, covering missed webhooks and the
 * mobile flow, which authorises on Razorpay's hosted page with no callback.
 */
export async function reconcilePendingSwitch(tenantId: string): Promise<void> {
  const client = forTenant(tenantId) as any
  // A first subscription authorised on the hosted page has no /verify call.
  const open = await findOpenSubscription(tenantId)
  if (open?.status === 'created' && open.attempt_id) {
    try {
      const provider = await fetchRazorpaySubscription(open.provider_subscription_id)
      const attempt = provider.status !== 'created' ? await findAttempt(tenantId, open.attempt_id) : null
      if (attempt) await adoptProviderSubscription(tenantId, attempt, provider)
    } catch {
      // Webhooks remain authoritative; the next billing-page load retries.
    }
  }
  const pending = await findPendingSwitch(tenantId)
  if (!pending) return
  let row = pending
  const startsAt = timestampOrNull(pending.switch_starts_at)
  if (pending.status === 'created' || (startsAt && startsAt.getTime() <= Date.now())) {
    let provider: RazorpaySubscription
    try {
      provider = await fetchRazorpaySubscription(pending.provider_subscription_id)
    } catch {
      return
    }
    const status = projectedProviderStatus(provider)
    row = await client.billing_subscriptions.update({
      where: { id: pending.id },
      data: { status, provider_payload: provider, ...providerSnapshotDates(provider) },
    })
    if (ENDED_STATUSES.includes(status)) return
  }
  try {
    await reconcilePlanSwitch(tenantId, row)
  } catch (error) {
    console.error('[billing] plan switch reconciliation deferred', error)
  }
}

export async function listInvoices(tenantId: string) {
  const client = forTenant(tenantId) as any
  const rows: any[] = await client.billing_subscriptions.findMany({
    where: { tenant_id: tenantId },
    orderBy: { created_at: 'desc' },
    take: 6,
  })
  try {
    const perSubscription = await Promise.all(rows.map(async (row) =>
      (await listRazorpayInvoices(row.provider_subscription_id)).map((invoice) => ({ invoice, row }))))
    const invoices = perSubscription.flat().map(({ invoice, row }) => ({
      id: invoice.id,
      status: invoice.status ?? 'issued',
      amountMinor: Number(invoice.amount_paid || invoice.amount || 0),
      currency: invoice.currency ?? row.currency,
      issuedAt: unixIso(invoice.date),
      paidAt: unixIso(invoice.paid_at),
      periodStart: unixIso(invoice.billing_start),
      periodEnd: unixIso(invoice.billing_end),
      planKey: row.plan_key,
      url: invoice.short_url || null,
    })).sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''))
    return { invoices, available: true }
  } catch {
    return { invoices: [], available: false }
  }
}
