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

const INDIA_PLAN_KEYS = ['starter', 'growth', 'pro'] as const

export type IndiaPlanKey = (typeof INDIA_PLAN_KEYS)[number]

export type BillingAddonKey = 'location' | 'register' | 'user'

export type BillingAddonDefinition = {
  key: BillingAddonKey
  label: string
  unitAmountMinor: number
}

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
  addons: BillingAddonDefinition[]
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
    includedStores: 2,
    region: 'IN',
    currency: 'INR',
    name: 'Starter',
    description: 'Everything a growing retailer needs to run up to two locations.',
    popular: false,
    features: ['2 locations', '5 active users', '3 active registers', 'Unlimited POS transactions', 'ML reorder intelligence', 'GST-ready reports and CSV export', 'Offline billing and sync'],
    entitlements: retailEntitlements(2, 5, 3),
    addons: [],
    monthly: { amountMinor: 79_900, taxRateBps: 1_800 },
    annual: { amountMinor: 799_000, taxRateBps: 1_800 },
  },
  {
    key: 'growth',
    includedStores: 5,
    region: 'IN',
    currency: 'INR',
    name: 'Growth',
    description: 'The complete operating system for multi-location retail teams.',
    popular: true,
    features: ['5 locations', '15 active users', '8 active registers', 'Unlimited POS transactions', 'ML reorder intelligence', 'GST-ready reports and CSV export', 'Offline billing and sync', 'Priority support'],
    entitlements: retailEntitlements(5, 15, 8),
    addons: [],
    monthly: { amountMinor: 149_900, taxRateBps: 1_800 },
    annual: { amountMinor: 1_499_000, taxRateBps: 1_800 },
  },
  {
    key: 'pro',
    includedStores: 8,
    region: 'IN',
    currency: 'INR',
    name: 'Pro',
    description: 'Maximum included capacity with flexible add-ons for larger retailers.',
    popular: false,
    features: ['8 locations included', '20 active users included', '12 active registers included', 'Unlimited POS transactions', 'ML reorder intelligence', 'GST-ready reports and CSV export', 'Offline billing and sync', 'Priority support'],
    entitlements: retailEntitlements(8, 20, 12),
    addons: [
      { key: 'location', label: 'Additional location', unitAmountMinor: 29_900 },
      { key: 'register', label: 'Additional register', unitAmountMinor: 19_900 },
      { key: 'user', label: 'Additional user', unitAmountMinor: 9_900 },
    ],
    monthly: { amountMinor: 299_900, taxRateBps: 1_800 },
    annual: { amountMinor: 2_999_000, taxRateBps: 1_800 },
  },
  {
    key: 'starter',
    includedStores: 2,
    region: 'INTL',
    currency: 'USD',
    name: 'Starter',
    description: 'Everything a growing retailer needs to run up to two locations.',
    popular: false,
    features: ['2 locations', '5 active users', '3 active registers', 'Unlimited POS transactions', 'ML reorder intelligence', 'Sales tax configuration', 'Digital receipts', 'Offline billing'],
    entitlements: retailEntitlements(2, 5, 3),
    addons: [],
    monthly: { amountMinor: 4_900 },
    annual: { amountMinor: 49_000 },
  },
  {
    key: 'growth',
    includedStores: 5,
    region: 'INTL',
    currency: 'USD',
    name: 'Growth',
    description: 'The complete operating system for multi-location retail teams.',
    popular: true,
    features: ['5 locations', '15 active users', '8 active registers', 'Unlimited POS transactions', 'ML reorder intelligence', 'Sales tax configuration', 'Digital receipts', 'Offline billing', 'Priority support'],
    entitlements: retailEntitlements(5, 15, 8),
    addons: [],
    monthly: { amountMinor: 9_900 },
    annual: { amountMinor: 99_000 },
  },
  {
    key: 'pro',
    includedStores: 15,
    region: 'INTL',
    currency: 'USD',
    name: 'Pro',
    description: 'Maximum included capacity with flexible add-ons for larger retailers.',
    popular: false,
    features: ['15 locations included', '25 active users included', '15 active registers included', 'Unlimited POS transactions', 'ML reorder intelligence', 'Sales tax configuration', 'Digital receipts', 'Offline billing', 'Priority support'],
    entitlements: retailEntitlements(15, 25, 15),
    addons: [
      { key: 'location', label: 'Additional location', unitAmountMinor: 1_500 },
      { key: 'register', label: 'Additional register', unitAmountMinor: 1_000 },
      { key: 'user', label: 'Additional user', unitAmountMinor: 500 },
    ],
    monthly: { amountMinor: 19_900 },
    annual: { amountMinor: 199_000 },
  },
]

function retailEntitlements(maxLocations: number, maxActiveUsers: number, maxActiveRegisters: number): BillingEntitlementLimits {
  return {
    maxLocations,
    maxActiveUsers,
    maxActiveRegisters,
    monthlyPosTransactions: 'unlimited',
    monthlySalesOrders: 'unlimited',
    monthlyEcommerceOrders: 'unlimited',
    monthlyPurchaseOrders: 'unlimited',
    monthlyBills: 'unlimited',
    dailyApiCalls: 'unlimited',
    integrations: 0,
  }
}

function legacyIndiaEntitlements(planKey: string): BillingEntitlementLimits {
  switch (planKey) {
    case 'free':
      return {
        maxLocations: 1, maxActiveUsers: 1, maxActiveRegisters: 1,
        monthlyPosTransactions: 50, monthlySalesOrders: 50, monthlyEcommerceOrders: 50,
        monthlyPurchaseOrders: 20, monthlyBills: 20, dailyApiCalls: 1_500, integrations: 0,
      }
    case 'standard':
      return { ...retailEntitlements(1, 3, 1), monthlySalesOrders: 500, monthlyEcommerceOrders: 500, monthlyPurchaseOrders: 500, monthlyBills: 500, dailyApiCalls: 2_500 }
    case 'professional':
      return { ...retailEntitlements(3, 10, 3), monthlySalesOrders: 5_000, monthlyEcommerceOrders: 5_000, monthlyPurchaseOrders: 2_500, monthlyBills: 2_500, dailyApiCalls: 5_000 }
    case 'premium':
      return { ...retailEntitlements(5, 15, 5), monthlySalesOrders: 10_000, monthlyEcommerceOrders: 10_000, monthlyPurchaseOrders: 5_000, monthlyBills: 5_000, dailyApiCalls: 7_500 }
    default:
      return { ...DEFAULT_CATALOG.find((plan) => plan.region === 'IN')!.entitlements }
  }
}

function internationalEntitlements(maxLocations: number): BillingEntitlementLimits {
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
  return { ...DEFAULT_CATALOG.find((plan) => plan.region === 'IN')!.entitlements }
}

function lowestInternationalEntitlements(): BillingEntitlementLimits {
  return { ...DEFAULT_CATALOG.find((plan) => plan.region === 'INTL')!.entitlements }
}

export function canonicalBillingRegion(region: BillingRegion): Exclude<BillingRegion, 'US'> {
  return region === 'US' ? 'INTL' : region
}

function isRegion(value: unknown): value is BillingRegion {
  return value === 'IN' || value === 'INTL' || value === 'US'
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

function isAddon(value: unknown): value is BillingAddonDefinition {
  if (!value || typeof value !== 'object') return false
  const addon = value as Record<string, unknown>
  return (addon.key === 'location' || addon.key === 'register' || addon.key === 'user')
    && typeof addon.label === 'string'
    && Number.isSafeInteger(addon.unitAmountMinor)
    && Number(addon.unitAmountMinor) >= 0
}

function isPlan(value: unknown): value is Omit<BillingPlanDefinition, 'entitlements' | 'addons'> & {
  entitlements?: BillingEntitlementLimits
  addons?: BillingAddonDefinition[]
} {
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
    && (plan.addons === undefined || (Array.isArray(plan.addons) && plan.addons.every(isAddon)))
    && isPeriod(plan.monthly)
    && isPeriod(plan.annual)
}

function legacyEntitlements(plan: { key: string; region: BillingRegion; includedStores: number }): BillingEntitlementLimits {
  const region = canonicalBillingRegion(plan.region)
  if (region === 'IN') {
    if (['free', 'standard', 'professional', 'premium'].includes(plan.key)) return legacyIndiaEntitlements(plan.key)
    const known = DEFAULT_CATALOG.find((entry) => entry.region === 'IN' && entry.key === plan.key)
    if (known) return { ...known.entitlements }
    return { ...lowestIndiaEntitlements(), maxLocations: plan.includedStores }
  }
  const known = DEFAULT_CATALOG.find((entry) => entry.region === 'INTL' && entry.key === plan.key)
  if (known) return { ...known.entitlements }
  return { ...lowestInternationalEntitlements(), maxLocations: plan.includedStores }
}

function normalisePlan(plan: Omit<BillingPlanDefinition, 'entitlements' | 'addons'> & {
  entitlements?: BillingEntitlementLimits
  addons?: BillingAddonDefinition[]
}): BillingPlanDefinition {
  return {
    ...plan,
    region: canonicalBillingRegion(plan.region),
    entitlements: plan.entitlements ? { ...plan.entitlements } : legacyEntitlements(plan),
    addons: plan.addons ? plan.addons.map((addon) => ({ ...addon })) : [],
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
  const customInternational = new Map(
    custom
      .filter((plan) => plan.region === 'INTL')
      .map((plan) => [plan.key, plan]),
  )
  const customIndia = new Map(
    custom
      .filter((plan) => plan.region === 'IN' && (INDIA_PLAN_KEYS as readonly string[]).includes(plan.key))
      .map((plan) => [plan.key, plan]),
  )

  // The environment may provide provider Plan IDs and tax overrides, but the
  // product catalogue remains backend-owned. In particular, an old deployment
  // cannot resurrect the retired Free/Standard/Professional/Premium tiers.
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
        addons: override.addons.length > 0 ? override.addons : plan.addons,
      }
    })

  const international = DEFAULT_CATALOG
    .filter((plan) => plan.region === 'INTL')
    .map((plan) => {
      const override = customInternational.get(plan.key)
      if (!override) return plan
      return {
        ...plan,
        ...override,
        monthly: { ...plan.monthly, ...override.monthly },
        annual: { ...plan.annual, ...override.annual },
        entitlements: { ...plan.entitlements, ...override.entitlements },
        addons: override.addons.length > 0 ? override.addons : plan.addons,
      }
    })

  return [...india, ...international]
}

function roundMinor(value: number): number {
  return Math.round(value)
}

export function getBillingMode(): 'test' | 'live' {
  return process.env.RAZORPAY_MODE === 'live' ? 'live' : 'test'
}

export function getPlan(region: BillingRegion, planKey: string): BillingPlanDefinition | undefined {
  const canonicalRegion = canonicalBillingRegion(region)
  return loadCatalog().find((plan) => plan.region === canonicalRegion && plan.key === planKey)
}

export function getPlans(region: BillingRegion): BillingPlanDefinition[] {
  const canonicalRegion = canonicalBillingRegion(region)
  return loadCatalog().filter((plan) => plan.region === canonicalRegion)
}

export function getPeriod(plan: BillingPlanDefinition, billingCycle: BillingCycle): CatalogPeriod {
  return plan[billingCycle]
}

export function calculateQuote(plan: BillingPlanDefinition, billingCycle: BillingCycle): BillingQuote {
  const period = getPeriod(plan, billingCycle)
  const configuredTaxRateBps = period.taxRateBps ?? (
    plan.region !== 'IN'
      ? Number.parseInt(process.env.INTERNATIONAL_SUBSCRIPTION_TAX_RATE_BPS ?? process.env.US_SUBSCRIPTION_TAX_RATE_BPS ?? '0', 10)
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
    addons: plan.addons.map((addon) => ({ ...addon })),
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
export function includedStoresForPlan(planKey: string, region?: BillingRegion): number {
  const legacyAllowance: Record<string, number> = {
    free: 1,
    standard: 1,
    professional: region === 'US' ? 5 : 3,
    premium: 5,
    essentials: 1,
  }
  const plan = region
    ? getPlan(region, planKey)
    : loadCatalog().find((entry) => entry.key === planKey)
  const limit = plan?.entitlements.maxLocations ?? plan?.includedStores
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1) return limit
  return legacyAllowance[planKey] ?? 1
}
