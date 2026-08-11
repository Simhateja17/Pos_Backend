import type { BillingCycle, BillingCurrency, BillingRegion } from '../contracts/schemas/billing'

type CatalogPeriod = {
  amountMinor: number
  taxRateBps?: number
  providerPlanId?: string
}

export const ENTITLEMENT_KEYS = [
  'maxLocations',
  'maxActiveUsers',
  'maxActiveRegisters',
  'monthlyPosTransactions',
  'monthlySalesOrders',
  'monthlyEcommerceOrders',
  'monthlyPurchaseOrders',
  'monthlyBills',
  'dailyApiCalls',
  'integrations',
] as const

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number]
export type EntitlementValue = number | 'unlimited'
export type BillingEntitlementLimits = Record<EntitlementKey, EntitlementValue>

const INDIA_PLAN_KEYS = ['free', 'standard', 'professional', 'premium'] as const

export type IndiaPlanKey = (typeof INDIA_PLAN_KEYS)[number]

export type BillingPlanDefinition = {
  key: string
  /**
   * Shops this plan covers before add-ons (Phase 8 task 12).
   *
   * Store capacity is snapshotted with the subscription. India register
   * allowances are separate entitlement values; the catalogue never derives
   * them from a per-till price.
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
  entitlements: BillingEntitlementLimits
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
    key: 'free',
    includedStores: 1,
    region: 'IN',
    currency: 'INR',
    name: 'Free',
    description: 'Essential POS billing and inventory for one retail location.',
    popular: false,
    features: ['POS billing and cart', 'Inventory management', 'GST-ready reports and CSV export', 'Offline billing and sync', 'Email support'],
    entitlements: indiaEntitlements(1, 1, 1, 50, 50, 20, 20, 1_500),
    monthly: { amountMinor: 0, taxRateBps: 0 },
    annual: { amountMinor: 0, taxRateBps: 0 },
  },
  {
    key: 'standard',
    includedStores: 1,
    region: 'IN',
    currency: 'INR',
    name: 'Standard',
    description: 'Reliable POS operations for a growing single-location team.',
    popular: false,
    features: ['Everything in Free', 'Up to 3 active users', 'Up to 1 active register', 'Unlimited POS transactions', 'Email support'],
    entitlements: indiaEntitlements(1, 3, 1, 'unlimited', 500, 500, 500, 2_500),
    monthly: { amountMinor: 64_900, taxRateBps: 1_800 },
    annual: { amountMinor: 778_800, taxRateBps: 1_800 },
  },
  {
    key: 'professional',
    includedStores: 3,
    region: 'IN',
    currency: 'INR',
    name: 'Professional',
    description: 'Multi-location POS operations for established retail teams.',
    popular: true,
    features: ['Everything in Standard', 'Up to 10 active users', 'Up to 3 active registers', 'Unlimited POS transactions', 'Priority support'],
    entitlements: indiaEntitlements(3, 10, 3, 'unlimited', 5_000, 2_500, 2_500, 5_000),
    monthly: { amountMinor: 129_900, taxRateBps: 1_800 },
    annual: { amountMinor: 1_558_800, taxRateBps: 1_800 },
  },
  {
    key: 'premium',
    includedStores: 5,
    region: 'IN',
    currency: 'INR',
    name: 'Premium',
    description: 'The highest included capacity for multi-location retail operations.',
    popular: false,
    features: ['Everything in Professional', 'Up to 15 active users', 'Up to 5 active registers', 'Unlimited POS transactions', 'Priority support'],
    entitlements: indiaEntitlements(5, 15, 5, 'unlimited', 10_000, 5_000, 5_000, 7_500),
    monthly: { amountMinor: 209_900, taxRateBps: 1_800 },
    annual: { amountMinor: 2_518_800, taxRateBps: 1_800 },
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
    entitlements: usEntitlements(1),
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
    entitlements: usEntitlements(5),
    monthly: { amountMinor: 7_900 },
    annual: { amountMinor: 79_000 },
  },
]

function indiaEntitlements(
  maxLocations: number,
  maxActiveUsers: number,
  maxActiveRegisters: number,
  monthlyPosTransactions: EntitlementValue,
  monthlySalesOrders: number,
  monthlyPurchaseOrders: number,
  monthlyBills: number,
  dailyApiCalls: number,
): BillingEntitlementLimits {
  return {
    maxLocations,
    maxActiveUsers,
    maxActiveRegisters,
    monthlyPosTransactions,
    monthlySalesOrders,
    monthlyEcommerceOrders: monthlySalesOrders,
    monthlyPurchaseOrders,
    monthlyBills,
    dailyApiCalls,
    // Integrations are deliberately stored as a future entitlement only. No
    // integration module is enabled by this catalogue.
    integrations: 0,
  }
}

function usEntitlements(maxLocations: number): BillingEntitlementLimits {
  return {
    maxLocations,
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
}

function lowestIndiaEntitlements(): BillingEntitlementLimits {
  return { ...DEFAULT_CATALOG.find((plan) => plan.key === 'free')!.entitlements }
}

function lowestUsEntitlements(): BillingEntitlementLimits {
  return { ...DEFAULT_CATALOG.find((plan) => plan.key === 'essentials')!.entitlements }
}

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

function isEntitlementValue(value: unknown): value is EntitlementValue {
  return value === 'unlimited' || (Number.isSafeInteger(value) && Number(value) >= 0)
}

function isEntitlementLimits(value: unknown): value is BillingEntitlementLimits {
  if (!value || typeof value !== 'object') return false
  const limits = value as Record<string, unknown>
  return ENTITLEMENT_KEYS.every((key) => isEntitlementValue(limits[key]))
}

function isPlan(value: unknown): value is Omit<BillingPlanDefinition, 'entitlements'> & { entitlements?: BillingEntitlementLimits } {
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
    && (plan.entitlements === undefined || isEntitlementLimits(plan.entitlements))
    && isPeriod(plan.monthly)
    && isPeriod(plan.annual)
}

function legacyEntitlements(plan: { key: string; region: BillingRegion; includedStores: number }): BillingEntitlementLimits {
  if (plan.region === 'IN') {
    const known = DEFAULT_CATALOG.find((entry) => entry.region === 'IN' && entry.key === plan.key)
    if (known) return { ...known.entitlements }
    return { ...lowestIndiaEntitlements(), maxLocations: plan.includedStores }
  }
  const known = DEFAULT_CATALOG.find((entry) => entry.region === 'US' && entry.key === plan.key)
  if (known) return { ...known.entitlements }
  return { ...lowestUsEntitlements(), maxLocations: plan.includedStores }
}

function normalisePlan(plan: Omit<BillingPlanDefinition, 'entitlements'> & { entitlements?: BillingEntitlementLimits }): BillingPlanDefinition {
  return {
    ...plan,
    entitlements: plan.entitlements ? { ...plan.entitlements } : legacyEntitlements(plan),
  }
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

  const custom = parsed.map(normalisePlan)
  const customUs = new Map(
    custom
      .filter((plan) => plan.region === 'US')
      .map((plan) => [plan.key, plan]),
  )
  const customIndia = new Map(
    custom
      .filter((plan) => plan.region === 'IN' && (INDIA_PLAN_KEYS as readonly string[]).includes(plan.key))
      .map((plan) => [plan.key, plan]),
  )

  // The environment may only provide provider Plan IDs. It must not be able
  // to resurrect the retired Starter/Growth/Enterprise India catalogue.
  const india = DEFAULT_CATALOG
    .filter((plan) => plan.region === 'IN')
    .map((plan) => {
      const override = customIndia.get(plan.key)
      if (!override) return plan
      return {
        ...plan,
        ...override,
        monthly: { ...plan.monthly, ...override.monthly },
        annual: { ...plan.annual, ...override.annual },
        entitlements: { ...plan.entitlements, ...override.entitlements },
      }
    })

  const us = DEFAULT_CATALOG
    .filter((plan) => plan.region === 'US')
    .map((plan) => {
      const override = customUs.get(plan.key)
      if (!override) return plan
      return {
        ...plan,
        ...override,
        monthly: { ...plan.monthly, ...override.monthly },
        annual: { ...plan.annual, ...override.annual },
        entitlements: { ...plan.entitlements, ...override.entitlements },
      }
    })

  return [...india, ...us]
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
    entitlements: plan.entitlements,
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
  const limit = plan?.entitlements.maxLocations ?? plan?.includedStores
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 ? limit : 1
}
