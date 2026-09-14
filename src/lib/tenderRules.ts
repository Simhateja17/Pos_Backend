export type SaleTenderMethod = 'cash' | 'card' | 'check' | 'upi' | 'credit'

/**
 * The shared payment schema deliberately describes the superset used by both
 * regional editions. The sale/return routes apply the region policy after
 * loading the server-owned tenant; a client cannot opt into another region's
 * tender merely by posting a valid enum value.
 */
export function allowedTenderMethodsForCountry(country: string | null | undefined): ReadonlySet<SaleTenderMethod> {
  return String(country ?? '').trim().toUpperCase() === 'IN'
    ? new Set<SaleTenderMethod>(['cash', 'card', 'upi', 'credit'])
    : new Set<SaleTenderMethod>(['cash', 'card', 'check'])
}

export function unsupportedTenderMethods(
  country: string | null | undefined,
  methods: Iterable<string>,
): string[] {
  const allowed = allowedTenderMethodsForCountry(country)
  return [...new Set([...methods].filter((method) => !allowed.has(method as SaleTenderMethod)))]
}
