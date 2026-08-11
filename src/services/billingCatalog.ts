import type { BillingCycle, BillingCurrency, BillingRegion } from '../contracts/schemas/billing'

type CatalogPeriod = {
  amountMinor: number
  taxRateBps?: number
  providerPlanId?: string
}

export type BillingPlanDefinition = {
  key: string
  /**
   * Shops this plan covers before add-ons (Phase 8 task 12).
   *
   * Charged PER SHOP, never per counter — terminals stay unlimited and free,
   * because per-till pricing is a known negative in this market.
   *
   * Tiered rather than linear because the market prices multi-outlet as a
   * different product, not the same one multiplied. These numbers are a
   * starting point, not a settled decision: change them here, and existing
   * subscribers keep whatever they bought (their allowance is denormalised
   * onto the subscription row by migration 0053).
   */
  includedStores: number
  region: BillingRegion
  currency: BillingCurrency
  name: string
  description: string
  popular: boolean
  features: string[]
  monthly: CatalogPeriod
  annual: CatalogPeriod
}

export type BillingQuote = {
  baseAmountMinor: number
  taxAmountMinor: number
  totalAmountMinor: number
  taxRateBps: number
  taxMode: 'included' | 'exclusive'
  taxLabel: string
}

const DEFAULT_CATALOG: BillingPlanDefinition[] = [
  {
    key: 'starter',
    includedStores: 1,
    region: 'IN',
    currency: 'INR',
    name: 'Starter',
    description: 'Core billing and inventory for one retail store.',
    popular: false,
    features: ['GST-native billing & cart', 'UPI, card & cash payments', 'Inventory up to 2,000 SKUs', '5 staff accounts', 'GST reports & export'],
    monthly: { amountMinor: 99_900, taxRateBps: 1_800 },
    annual: { amountMinor: 958_800, taxRateBps: 1_800 },
  },
  {
    key: 'growth',
    includedStores: 3,
    region: 'IN',
    currency: 'INR',
    name: 'Growth',
    description: 'Multi-store operations, loyalty, campaigns and AI assistance.',
    popular: true,
    features: ['Everything in Starter', 'Loyalty, gift cards & CRM', 'Sales channels', 'AI Copilot', 'WhatsApp campaigns', 'Priority support'],
    monthly: { amountMinor: 249_900, taxRateBps: 1_800 },
    annual: { amountMinor: 2_398_800, taxRateBps: 1_800 },
  },
  {
    key: 'essentials',
    includedStores: 1,
    region: 'US',
    currency: 'USD',
    name: 'Essentials',
    description: 'Essential sales, inventory and offline billing for one location.',
    popular: false,
    features: ['1 location · 2 registers', 'Sales tax configuration', 'Digital receipts', 'Offline billing', 'Email support'],
    monthly: { amountMinor: 2_900 },
    annual: { amountMinor: 29_000 },
  },
  {
    key: 'professional',
    includedStores: 5,
    region: 'US',
    currency: 'USD',
    name: 'Professional',
    description: 'Advanced retail operations for growing US teams.',
    popular: true,
    features: ['Everything in Essentials', 'Unlimited registers', 'Advanced reporting', 'Multi-location operations', 'Priority support'],
    monthly: { amountMinor: 7_900 },
    annual: { amountMinor: 79_000 },
  },
]

function isRegion(value: unknown): value is BillingRegion {
  return value === 'IN' || value === 'US'
}

function isCurrency(value: unknown): value is BillingCurrency {
  return value === 'INR' || value === 'USD'
}

function isPeriod(value: unknown): value is CatalogPeriod {
  if (!value || typeof value !== 'object') return false
  const period = value as Record<string, unknown>
  return Number.isSafeInteger(period.amountMinor) && Number(period.amountMinor) >= 0 && (
    period.taxRateBps === undefined || (Number.isSafeInteger(period.taxRateBps) && Number(period.taxRateBps) >= 0)
  ) && (
    period.providerPlanId === undefined || typeof period.providerPlanId === 'string'
  )
}

function isPlan(value: unknown): value is BillingPlanDefinition {
  if (!value || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return typeof plan.key === 'string'
    && Number.isSafeInteger(plan.includedStores)
    && Number(plan.includedStores) >= 1
    && isRegion(plan.region)
    && isCurrency(plan.currency)
    && typeof plan.name === 'string'
    && typeof plan.description === 'string'
    && typeof plan.popular === 'boolean'
    && Array.isArray(plan.features)
    && plan.features.every((feature) => typeof feature === 'string')
    && isPeriod(plan.monthly)
    && isPeriod(plan.annual)
}

function loadCatalog(): BillingPlanDefinition[] {
  const raw = process.env.BILLING_PLAN_CATALOG_JSON?.trim()
  if (!raw) return DEFAULT_CATALOG

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Older versions of the provisioning script wrote JSON with literal
    // backslashes into dotenv values (for example [{\"key\":\"starter\"}]).
    // Accept that one legacy representation so a deployment can recover while
    // the environment variable is replaced with the raw JSON form.
    const unescaped = raw.replaceAll('\\"', '"')
    if (unescaped === raw) throw new Error('BILLING_PLAN_CATALOG_JSON is not valid JSON')
    try {
      parsed = JSON.parse(unescaped)
    } catch {
      throw new Error('BILLING_PLAN_CATALOG_JSON is not valid JSON')
    }
  }
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new Error('BILLING_PLAN_CATALOG_JSON is not valid JSON')
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(isPlan)) {
    throw new Error('BILLING_PLAN_CATALOG_JSON has an invalid plan shape')
  }
  return parsed
}

function roundMinor(value: number): number {
  return Math.round(value)
}

export function getBillingMode(): 'test' | 'live' {
  return process.env.RAZORPAY_MODE === 'live' ? 'live' : 'test'
}

export function getPlan(region: BillingRegion, planKey: string): BillingPlanDefinition | undefined {
  return loadCatalog().find((plan) => plan.region === region && plan.key === planKey)
}

export function getPlans(region: BillingRegion): BillingPlanDefinition[] {
  return loadCatalog().filter((plan) => plan.region === region)
}

export function getPeriod(plan: BillingPlanDefinition, billingCycle: BillingCycle): CatalogPeriod {
  return plan[billingCycle]
}

export function calculateQuote(plan: BillingPlanDefinition, billingCycle: BillingCycle): BillingQuote {
  const period = getPeriod(plan, billingCycle)
  const configuredTaxRateBps = period.taxRateBps ?? (
    plan.region === 'US'
      ? Number.parseInt(process.env.US_SUBSCRIPTION_TAX_RATE_BPS ?? '0', 10)
      : 1_800
  )
  const taxRateBps = Number.isFinite(configuredTaxRateBps) && configuredTaxRateBps >= 0 ? configuredTaxRateBps : 0

  if (plan.region === 'IN') {
    // Indian plan prices are customer-facing tax-inclusive totals. The
    // provider plan amount is the total, while this breakdown is derived for
    // the hosted payment screen and app receipt.
    const taxAmountMinor = roundMinor(period.amountMinor * taxRateBps / (10_000 + taxRateBps))
    return {
      baseAmountMinor: period.amountMinor - taxAmountMinor,
      taxAmountMinor,
      totalAmountMinor: period.amountMinor,
      taxRateBps,
      taxMode: 'included',
      taxLabel: `GST (${(taxRateBps / 100).toFixed(0)}% included)`,
    }
  }

  const taxAmountMinor = roundMinor(period.amountMinor * taxRateBps / 10_000)
  return {
    baseAmountMinor: period.amountMinor,
    taxAmountMinor,
    totalAmountMinor: period.amountMinor + taxAmountMinor,
    taxRateBps,
    taxMode: 'exclusive',
    taxLabel: taxRateBps > 0 ? `Estimated tax (${(taxRateBps / 100).toFixed(2)}%)` : 'Tax calculated according to your tax settings',
  }
}

export function toPlanOption(plan: BillingPlanDefinition) {
  const monthlyQuote = calculateQuote(plan, 'monthly')
  const annualQuote = calculateQuote(plan, 'annual')
  return {
    key: plan.key,
    includedStores: plan.includedStores,
    region: plan.region,
    currency: plan.currency,
    name: plan.name,
    description: plan.description,
    popular: plan.popular,
    features: plan.features,
    monthly: monthlyQuote,
    annual: annualQuote,
    monthlyAvailable: Boolean(plan.monthly.providerPlanId),
    annualAvailable: Boolean(plan.annual.providerPlanId),
    providerConfigured: {
      monthly: Boolean(plan.monthly.providerPlanId),
      annual: Boolean(plan.annual.providerPlanId),
    },
  }
}

export function providerPlanId(plan: BillingPlanDefinition, billingCycle: BillingCycle): string | undefined {
  return getPeriod(plan, billingCycle).providerPlanId
}

/**
 * Shops a plan key covers, defaulting to 1 for an unknown key.
 *
 * Defaults DOWN rather than up: an unrecognised plan should leave a customer
 * able to run the shop they have, not silently grant unlimited outlets. A
 * too-low limit produces a support conversation; a too-high one produces
 * unbilled shops nobody notices for months.
 */
export function includedStoresForPlan(planKey: string): number {
  const plan = loadCatalog().find((entry) => entry.key === planKey)
  return plan?.includedStores ?? 1
}
