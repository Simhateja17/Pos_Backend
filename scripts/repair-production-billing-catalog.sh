#!/usr/bin/env bash

set -euo pipefail

reload=false
if [[ "${1:-}" == "--reload" ]]; then
  reload=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: bash scripts/repair-production-billing-catalog.sh [--reload]" >&2
  exit 2
fi

if [[ ! -f .env || ! -f package.json ]]; then
  echo "Run this script from the backend directory." >&2
  exit 1
fi

backup=".env.billing-backup.$(date +%Y%m%d%H%M%S)"
cp .env "$backup"
echo "Backed up .env to $backup"

node <<'NODE'
const fs = require('node:fs')
const dotenv = require('dotenv')

const file = '.env'
const source = fs.readFileSync(file, 'utf8')
const env = dotenv.parse(source)
const raw = env.BILLING_PLAN_CATALOG_JSON?.trim()

if (!raw) throw new Error('BILLING_PLAN_CATALOG_JSON is empty')

function parseCatalog(value) {
  let current = value
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const parsed = JSON.parse(current)
      if (typeof parsed === 'string') {
        current = parsed
        continue
      }
      return parsed
    } catch {
      const unescaped = current.replaceAll('\\"', '"')
      if (unescaped === current) break
      current = unescaped
    }
  }
  throw new Error('Could not parse BILLING_PLAN_CATALOG_JSON')
}

function period(value, label) {
  if (!value || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0) {
    throw new Error(`${label} has no valid amountMinor`)
  }

  const result = { amountMinor: value.amountMinor }
  if (Number.isSafeInteger(value.taxRateBps) && value.taxRateBps >= 0) {
    result.taxRateBps = value.taxRateBps
  }

  const providerPlanId = value.providerPlanId ?? value.provider_plan_id
  if (typeof providerPlanId === 'string' && providerPlanId.trim()) {
    result.providerPlanId = providerPlanId
  }
  return result
}

function plan(value, key, region, currency, includedStores, defaultDescription) {
  if (value.currency !== currency) {
    throw new Error(`${value.key} must use ${currency}`)
  }

  return {
    key,
    includedStores,
    region,
    currency,
    name: region === 'IN'
      ? (key === 'standard' ? 'Standard' : 'Professional')
      : (key === 'essentials' ? 'Essentials' : 'Professional'),
    description: typeof value.description === 'string' && value.description.trim()
      ? value.description
      : defaultDescription,
    popular: typeof value.popular === 'boolean' ? value.popular : key === 'professional',
    features: Array.isArray(value.features) && value.features.every(feature => typeof feature === 'string')
      ? value.features
      : [],
    monthly: period(value.monthly, `${value.key}/monthly`),
    annual: period(value.annual, `${value.key}/annual`),
  }
}

const catalog = parseCatalog(raw)
if (!Array.isArray(catalog)) throw new Error('BILLING_PLAN_CATALOG_JSON must be an array')

const legacyKeys = { starter: 'standard', growth: 'professional' }
const legacyIndia = catalog.filter(value =>
  value?.region === 'IN' && Object.prototype.hasOwnProperty.call(legacyKeys, value.key),
)

if (legacyIndia.length !== 2) {
  throw new Error(`Expected legacy starter and growth plans; found: ${legacyIndia.map(value => value?.key).join(', ')}`)
}

const india = legacyIndia.map(value => {
  const key = legacyKeys[value.key]
  return plan(
    value,
    key,
    'IN',
    'INR',
    key === 'standard' ? 1 : 3,
    key === 'standard'
      ? 'Legacy single-location plan for production testing.'
      : 'Legacy multi-location plan for production testing.',
  )
})

const us = catalog
  .filter(value => value?.region === 'US' && ['essentials', 'professional'].includes(value.key))
  .map(value => plan(
    value,
    value.key,
    'US',
    'USD',
    value.key === 'essentials' ? 1 : 5,
    value.key === 'essentials'
      ? 'Essential retail operations for one location.'
      : 'Advanced retail operations for growing teams.',
  ))

const output = [...india, ...us]
const replacement = `BILLING_PLAN_CATALOG_JSON=${JSON.stringify(output)}`
const lines = source.split(/\r?\n/)
const index = lines.findIndex(line => /^\s*BILLING_PLAN_CATALOG_JSON\s*=/.test(line))
if (index < 0) throw new Error('BILLING_PLAN_CATALOG_JSON line not found in .env')
lines[index] = replacement
fs.writeFileSync(file, lines.join('\n'), 'utf8')

console.log(JSON.stringify(output.map(value => ({
  key: value.key,
  region: value.region,
  monthly: value.monthly.amountMinor,
  annual: value.annual.amountMinor,
  monthlyProviderPlanIdPresent: Boolean(value.monthly.providerPlanId),
  annualProviderPlanIdPresent: Boolean(value.annual.providerPlanId),
})), null, 2))
NODE

dry_run_output="$(mktemp)"
trap 'rm -f "$dry_run_output"' EXIT

npm run razorpay:plans -- --dry-run | tee "$dry_run_output"

for expected in \
  'IN/standard monthly: would validate existing Plan' \
  'IN/standard annual: would validate existing Plan' \
  'IN/professional monthly: would validate existing Plan' \
  'IN/professional annual: would validate existing Plan'; do
  if ! grep -Fq -- "$expected" "$dry_run_output"; then
    echo "Missing existing provider Plan validation: $expected" >&2
    echo "Do not reload PM2 and do not run --write-env." >&2
    exit 1
  fi
done

echo "Legacy India provider Plans validated successfully."

if [[ "$reload" != true ]]; then
  echo "No PM2 change made. Run this after reviewing the output:"
  echo "  pm2 reload couture-backend --update-env && pm2 save"
  exit 0
fi

pm2 reload couture-backend --update-env
pm2 save
curl --fail --silent --show-error http://127.0.0.1:4000/health
echo
echo "Backend reloaded and health check passed."
