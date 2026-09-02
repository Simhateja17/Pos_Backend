import { config as loadDotenv } from 'dotenv'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BillingCycle } from '../src/contracts/schemas/billing'
import type { BillingPlanDefinition } from '../src/services/billingCatalog'

type RazorpayMode = 'test' | 'live'

type RazorpayPlan = {
  id: string
  interval?: number
  period?: string
  item?: {
    amount?: number
    unit_amount?: number
    currency?: string
  }
  notes?: Record<string, string>
}

type RazorpayPlanCollection = {
  count?: number
  items?: RazorpayPlan[]
}

type CreatePlanRequest = {
  period: 'monthly' | 'yearly'
  interval: 1
  item: {
    name: string
    amount: number
    currency: string
    description: string
  }
  notes: Record<string, string>
}

type CliOptions = {
  dryRun: boolean
  writeEnv: boolean
  allowLive: boolean
  envFile: string
}

const ENV_CATALOG_KEY = 'BILLING_PLAN_CATALOG_JSON'
const API_BASE_URL = 'https://api.razorpay.com/v1'
const REQUEST_TIMEOUT_MS = 30_000

function usage(): string {
  return `Usage: npm run razorpay:plans -- [options]

Creates or reuses the Razorpay Plans required by the backend billing catalog.

Options:
  --dry-run              Print the Plan requests without calling Razorpay
  --write-env            Update BILLING_PLAN_CATALOG_JSON in the env file
  --env-file <path>      Env file to load/write (default: .env)
  --allow-live           Required before making live-mode changes
  --help                 Show this help

Examples:
  npm run razorpay:plans -- --dry-run
  npm run razorpay:plans -- --write-env
`
}

function parseArgs(argv: string[]): CliOptions | { help: true } {
  const options: CliOptions = {
    dryRun: false,
    writeEnv: false,
    allowLive: false,
    envFile: '.env',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (argument === '--write-env') {
      options.writeEnv = true
      continue
    }
    if (argument === '--allow-live') {
      options.allowLive = true
      continue
    }
    if (argument === '--env-file' || argument.startsWith('--env-file=')) {
      const value = argument === '--env-file' ? argv[++index] : argument.slice('--env-file='.length)
      if (!value?.trim()) throw new Error('--env-file requires a path')
      options.envFile = value.trim()
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }

  if (options.dryRun && options.writeEnv) {
    throw new Error('--dry-run cannot be combined with --write-env')
  }
  return options
}

function activeMode(): RazorpayMode {
  const rawMode = process.env.RAZORPAY_MODE?.trim() || 'test'
  if (rawMode !== 'test' && rawMode !== 'live') {
    throw new Error('RAZORPAY_MODE must be either "test" or "live"')
  }
  return rawMode
}

function providerCredentials(mode: RazorpayMode): { keyId: string; keySecret: string } {
  const suffix = mode.toUpperCase()
  const keyId = process.env[`RAZORPAY_KEY_ID_${suffix}`]?.trim()
  const keySecret = process.env[`RAZORPAY_KEY_SECRET_${suffix}`]?.trim()
  if (!keyId || !keySecret) {
    throw new Error(`RAZORPAY_KEY_ID_${suffix} and RAZORPAY_KEY_SECRET_${suffix} are required`)
  }
  return { keyId, keySecret }
}

async function razorpayRequest<T>(
  credentials: { keyId: string; keySecret: string },
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, signal: controller.signal })
    const bodyText = await response.text()
    let body: unknown
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined
    } catch {
      body = undefined
    }

    if (!response.ok) {
      const description = body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: { description?: string } }).error?.description ?? 'Razorpay request failed')
        : 'Razorpay request failed'
      throw new Error(`Razorpay ${response.status}: ${description}`)
    }
    return body as T
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Razorpay request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchPlan(
  credentials: { keyId: string; keySecret: string },
  planId: string,
): Promise<RazorpayPlan> {
  return razorpayRequest<RazorpayPlan>(credentials, `/plans/${encodeURIComponent(planId)}`)
}

async function fetchAllPlans(
  credentials: { keyId: string; keySecret: string },
): Promise<RazorpayPlan[]> {
  const plans: RazorpayPlan[] = []
  let skip = 0

  while (true) {
    const page = await razorpayRequest<RazorpayPlanCollection>(credentials, `/plans?count=100&skip=${skip}`)
    const items = page.items ?? []
    plans.push(...items)
    if (items.length < 100) return plans
    skip += items.length
  }
}

async function createPlan(
  credentials: { keyId: string; keySecret: string },
  body: CreatePlanRequest,
): Promise<RazorpayPlan> {
  return razorpayRequest<RazorpayPlan>(credentials, '/plans', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// v3: every annual amount changed (12x monthly -> 10x monthly) and the India
// Pro plan's entitlements changed, so the v2 Plans are stale in the same way
// the pre-Ambel-pricing v1 Plans were. Razorpay Plan amounts are immutable,
// so reusing the v2 key would make validateProviderPlan() correctly refuse to
// proceed. Bumping the version again is what lets provisioning create fresh
// Plans under the current catalog without touching the v2 records.
export function catalogKey(plan: BillingPlanDefinition, billingCycle: BillingCycle): string {
  return `couture:v3:${plan.region}:${plan.key}:${billingCycle}`
}

export function razorpayPeriod(billingCycle: BillingCycle): 'monthly' | 'yearly' {
  return billingCycle === 'monthly' ? 'monthly' : 'yearly'
}

export function buildPlanRequest(
  plan: BillingPlanDefinition,
  billingCycle: BillingCycle,
  providerAmountMinor: number,
): CreatePlanRequest {
  return {
    period: razorpayPeriod(billingCycle),
    interval: 1,
    item: {
      name: `${plan.name} - ${billingCycle === 'monthly' ? 'Monthly' : 'Annual'}`,
      amount: providerAmountMinor,
      currency: plan.currency,
      description: plan.description,
    },
    notes: {
      catalog_key: catalogKey(plan, billingCycle),
      catalog_plan: plan.key,
      catalog_region: plan.region,
      billing_cycle: billingCycle,
    },
  }
}

function providerAmount(plan: BillingPlanDefinition, billingCycle: BillingCycle, quote: { totalAmountMinor: number }): number {
  // Razorpay charges the total provider amount. Indian catalog prices are
  // already GST-inclusive; international tax, when configured, is added by the quote.
  if (!Number.isSafeInteger(quote.totalAmountMinor) || quote.totalAmountMinor < 0) {
    throw new Error(`${plan.region}/${plan.key}/${billingCycle} has an invalid total amount`)
  }
  return quote.totalAmountMinor
}

function providerAmountFromPlan(plan: RazorpayPlan): number | undefined {
  const amount = plan.item?.amount ?? plan.item?.unit_amount
  return typeof amount === 'number' && Number.isSafeInteger(amount) ? amount : undefined
}

function validateProviderPlan(
  provider: RazorpayPlan,
  plan: BillingPlanDefinition,
  billingCycle: BillingCycle,
  expectedAmountMinor: number,
): void {
  if (!provider.id?.trim()) {
    throw new Error(`${plan.region}/${plan.key}/${billingCycle} returned a Razorpay Plan without an ID`)
  }
  const expectedPeriod = razorpayPeriod(billingCycle)
  const actualAmount = providerAmountFromPlan(provider)
  const actualCurrency = provider.item?.currency
  if (provider.period !== expectedPeriod || provider.interval !== 1) {
    throw new Error(
      `${plan.region}/${plan.key}/${billingCycle} points to ${provider.id}, but its frequency is ${provider.period ?? 'unknown'} every ${provider.interval ?? 'unknown'} (expected ${expectedPeriod} every 1)`,
    )
  }
  if (actualAmount !== expectedAmountMinor || actualCurrency !== plan.currency) {
    throw new Error(
      `${plan.region}/${plan.key}/${billingCycle} points to ${provider.id}, but its amount/currency is ${actualAmount ?? 'unknown'} ${actualCurrency ?? 'unknown'} (expected ${expectedAmountMinor} ${plan.currency})`,
    )
  }
}

function cloneCatalog(plans: BillingPlanDefinition[]): BillingPlanDefinition[] {
  return plans.map((plan) => ({
    ...plan,
    monthly: { ...plan.monthly },
    annual: { ...plan.annual },
  }))
}

function setProviderPlanId(
  plans: BillingPlanDefinition[],
  planIndex: number,
  billingCycle: BillingCycle,
  providerPlanId: string,
): void {
  plans[planIndex][billingCycle] = {
    ...plans[planIndex][billingCycle],
    providerPlanId,
  }
}

export function serializeCatalog(plans: BillingPlanDefinition[]): string {
  return JSON.stringify(plans)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function envCatalogLine(catalogJson: string): string {
  // Keep the JSON itself as the dotenv value. Wrapping JSON.stringify(catalogJson)
  // here would leave literal backslashes in process.env, making JSON.parse fail.
  return `${ENV_CATALOG_KEY}=${catalogJson}`
}

function updateEnvFile(envFile: string, catalogJson: string): void {
  if (!existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}. Use --env-file to select the backend env file.`)
  }
  const original = readFileSync(envFile, 'utf8')
  const lines = original.split(/\r?\n/)
  const replacement = envCatalogLine(catalogJson)
  const existingIndex = lines.findIndex((line) => /^\s*BILLING_PLAN_CATALOG_JSON\s*=/.test(line))
  if (existingIndex >= 0) lines[existingIndex] = replacement
  else lines.push(replacement)
  writeFileSync(envFile, lines.join('\n'), 'utf8')
}

function assertUniqueCatalog(plans: BillingPlanDefinition[]): void {
  const keys = new Set<string>()
  for (const plan of plans) {
    const key = `${plan.region}:${plan.key}`
    if (keys.has(key)) throw new Error(`Duplicate billing catalog plan: ${key}`)
    keys.add(key)
  }
}

function formatAmount(amountMinor: number, currency: string): string {
  const divisor = currency === 'JPY' ? 1 : 100
  return `${currency} ${(amountMinor / divisor).toFixed(divisor === 1 ? 0 : 2)}`
}

async function main(): Promise<void> {
  const parsedOptions = parseArgs(process.argv.slice(2))
  if ('help' in parsedOptions) {
    console.log(usage())
    return
  }
  const options = parsedOptions
  const envFile = resolve(process.cwd(), options.envFile)
  if (options.writeEnv && !existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}. Use --env-file to select the backend env file.`)
  }
  if (existsSync(envFile)) loadDotenv({ path: envFile })

  const mode = activeMode()
  if (mode === 'live' && !options.dryRun && !options.allowLive) {
    throw new Error('RAZORPAY_MODE=live detected. Re-run with --allow-live only after reviewing the catalog.')
  }

  const { getPlans, calculateQuote, getPeriod } = await import('../src/services/billingCatalog')
  const sourcePlans = [...getPlans('IN'), ...getPlans('INTL')]
  assertUniqueCatalog(sourcePlans)
  if (sourcePlans.length === 0) throw new Error('The billing catalog is empty')
  const outputPlans = cloneCatalog(sourcePlans)
  const cycles: BillingCycle[] = ['monthly', 'annual']
  const credentials = options.dryRun ? undefined : providerCredentials(mode)
  const existingPlans = options.dryRun ? [] : await fetchAllPlans(credentials!)
  const createdOrReused: Array<{ key: string; cycle: BillingCycle; id?: string; action: string; amount: number; currency: string }> = []

  for (let planIndex = 0; planIndex < sourcePlans.length; planIndex += 1) {
    const plan = sourcePlans[planIndex]
    for (const billingCycle of cycles) {
      const period = getPeriod(plan, billingCycle)
      const quote = calculateQuote(plan, billingCycle)
      const expectedAmountMinor = providerAmount(plan, billingCycle, quote)
      const configuredProviderPlanId = period.providerPlanId?.trim()

      if (options.dryRun) {
        createdOrReused.push({
          key: `${plan.region}/${plan.key}`,
          cycle: billingCycle,
          id: configuredProviderPlanId || undefined,
          action: configuredProviderPlanId ? 'would validate existing Plan' : 'would create Plan',
          amount: expectedAmountMinor,
          currency: plan.currency,
        })
        continue
      }

      let provider: RazorpayPlan
      let action: string
      if (configuredProviderPlanId) {
        provider = await fetchPlan(credentials!, configuredProviderPlanId)
        validateProviderPlan(provider, plan, billingCycle, expectedAmountMinor)
        action = 'validated existing Plan'
      } else {
        const key = catalogKey(plan, billingCycle)
        const matchingPlan = existingPlans.find((candidate) => candidate.notes?.catalog_key === key)
        if (matchingPlan) {
          validateProviderPlan(matchingPlan, plan, billingCycle, expectedAmountMinor)
          provider = matchingPlan
          action = 'reused matching Plan'
        } else {
          provider = await createPlan(credentials!, buildPlanRequest(plan, billingCycle, expectedAmountMinor))
          validateProviderPlan(provider, plan, billingCycle, expectedAmountMinor)
          existingPlans.push(provider)
          action = 'created Plan'
        }
        setProviderPlanId(outputPlans, planIndex, billingCycle, provider.id)
      }

      createdOrReused.push({
        key: `${plan.region}/${plan.key}`,
        cycle: billingCycle,
        id: provider.id,
        action,
        amount: expectedAmountMinor,
        currency: plan.currency,
      })
    }
  }

  const catalogJson = serializeCatalog(outputPlans)
  console.log(`${options.dryRun ? 'DRY RUN: no Razorpay Plans were created.' : `Razorpay ${mode} Plans are ready.`}`)
  for (const result of createdOrReused) {
    console.log(`- ${result.key} ${result.cycle}: ${result.action}${result.id ? ` (${result.id})` : ''} — ${formatAmount(result.amount, result.currency)}`)
  }

  if (options.writeEnv) {
    updateEnvFile(envFile, catalogJson)
    console.log(`Updated ${envFile} with ${ENV_CATALOG_KEY}. Restart the backend after loading this env file.`)
  } else {
    console.log('\nCopy this line to the backend environment (or re-run with --write-env):')
    console.log(`${ENV_CATALOG_KEY}=${shellQuote(catalogJson)}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Plan provisioning failed')
  process.exitCode = 1
})
