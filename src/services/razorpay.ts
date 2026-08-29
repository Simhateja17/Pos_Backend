import { createHmac, timingSafeEqual } from 'node:crypto'

export class RazorpayConfigurationError extends Error {
  status = 503
  readonly expose = true
  constructor(message = 'Razorpay billing is not configured for this environment') {
    super(message)
    this.name = 'RazorpayConfigurationError'
  }
}

export class RazorpayRequestError extends Error {
  constructor(
    public readonly providerStatus: number,
    message: string,
    public readonly providerBody?: unknown,
  ) {
    super(message)
    this.name = 'RazorpayRequestError'
  }
}

type RazorpayMode = 'test' | 'live'

type RazorpayConfig = {
  mode: RazorpayMode
  keyId: string
  keySecret: string
  webhookSecret: string
}

function activeMode(): RazorpayMode {
  return process.env.RAZORPAY_MODE === 'live' ? 'live' : 'test'
}

export function getRazorpayConfig(requireWebhookSecret = false): RazorpayConfig {
  const mode = activeMode()
  const suffix = mode.toUpperCase()
  const keyId = process.env[`RAZORPAY_KEY_ID_${suffix}`]?.trim()
  const keySecret = process.env[`RAZORPAY_KEY_SECRET_${suffix}`]?.trim()
  const webhookSecret = process.env[`RAZORPAY_WEBHOOK_SECRET_${suffix}`]?.trim()

  if (!keyId || !keySecret || (requireWebhookSecret && !webhookSecret)) {
    throw new RazorpayConfigurationError()
  }

  return { mode, keyId, keySecret, webhookSecret: webhookSecret ?? '' }
}

function apiUrl(path: string): string {
  return `https://api.razorpay.com/v1${path}`
}

async function razorpayRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getRazorpayConfig()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')

  const response = await fetch(apiUrl(path), { ...init, headers })
  const bodyText = await response.text()
  let body: unknown = undefined
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined
  } catch {
    body = bodyText
  }

  if (!response.ok) {
    const description = body && typeof body === 'object' && 'error' in body
      ? String((body as { error?: { description?: string } }).error?.description ?? 'Razorpay request failed')
      : 'Razorpay request failed'
    throw new RazorpayRequestError(response.status, description, body)
  }
  return body as T
}

export type RazorpaySubscription = {
  id: string
  plan_id: string
  status: string
  current_start?: number | null
  current_end?: number | null
  charge_at?: number | null
  start_at?: number | null
  end_at?: number | null
  remaining_count?: number | null
  notes?: Record<string, string>
  short_url?: string
  total_count?: number
}

export type RazorpayPayment = {
  id: string
  amount?: number
  currency?: string
  invoice_id?: string | null
  subscription_id?: string | null
  status?: string
}

export async function createRazorpaySubscription(input: {
  planId: string
  billingCycle: 'monthly' | 'annual'
  notes: Record<string, string>
}): Promise<RazorpaySubscription> {
  const totalCount = input.billingCycle === 'monthly' ? 1_200 : 100
  return razorpayRequest<RazorpaySubscription>('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: input.planId,
      total_count: totalCount,
      quantity: 1,
      customer_notify: true,
      notes: input.notes,
    }),
  })
}

export async function fetchRazorpaySubscription(subscriptionId: string): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`)
}

export type RazorpayPlan = {
  id: string
  item?: { amount?: number; currency?: string }
}

export async function fetchRazorpayPlan(planId: string): Promise<RazorpayPlan> {
  return razorpayRequest<RazorpayPlan>(`/plans/${encodeURIComponent(planId)}`)
}

export async function cancelRazorpaySubscription(
  subscriptionId: string,
  cancelAtCycleEnd = true,
): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancel_at_cycle_end: cancelAtCycleEnd }),
  })
}

type SubscriptionListResponse = { items?: RazorpaySubscription[] }

/**
 * Recovery for a network timeout after Razorpay accepted Create Subscription.
 * Notes contain our attempt ID, allowing a retry to adopt the original
 * provider object instead of creating a second recurring charge.
 */
export async function findRazorpaySubscriptionByAttemptId(attemptId: string): Promise<RazorpaySubscription | null> {
  const response = await razorpayRequest<SubscriptionListResponse>('/subscriptions?count=100')
  return (response.items ?? []).find((item) => item.notes?.billing_attempt_id === attemptId) ?? null
}

export function verifyRazorpayCheckoutSignature(input: {
  paymentId: string
  subscriptionId: string
  signature: string
}): boolean {
  const config = getRazorpayConfig()
  const expected = createHmac('sha256', config.keySecret)
    .update(`${input.paymentId}|${input.subscriptionId}`)
    .digest('hex')
  return safeCompare(expected, input.signature)
}

export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const config = getRazorpayConfig(true)
  const expected = createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex')
  return safeCompare(expected, signature)
}

function safeCompare(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const actualBuffer = Buffer.from(actual, 'utf8')
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

export function unixSecondsToDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null
}
