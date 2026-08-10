import type { Request } from 'express'
import { storeScopeWhere } from '../middleware/storeContext'

/**
 * Reads current stock as a variant -> quantity map, correctly scoped.
 *
 * WHY THIS EXISTS. Before Phase 8, `variant_stock_levels` held one row per
 * variant, so every caller did:
 *
 *     const levels = await client.variant_stock_levels.findMany({})
 *     new Map(levels.map(s => [s.variant_id, s.quantity]))
 *
 * That is now one row per (variant, STORE). The same code compiles, runs, and
 * silently lets whichever row happens to come last win — so a variant's
 * displayed stock becomes an arbitrary shop's shelf. Six call sites had this
 * shape; they all go through here instead.
 *
 * Under store scope the query is filtered to that shop. Under an owner's
 * business scope quantities are SUMMED across shops, which is the only honest
 * answer to "how many of these does the business have".
 */
export async function stockByVariant(
  client: any,
  req: Request,
  variantIds?: string[],
): Promise<Map<string, number>> {
  const where: Record<string, unknown> = { ...storeScopeWhere(req) }
  if (variantIds) {
    where.variant_id = { in: variantIds }
  }

  const levels = await client.variant_stock_levels.findMany({ where })

  const totals = new Map<string, number>()
  for (const level of levels) {
    // Additive, never assignment. Under business scope a variant legitimately
    // has several rows, and the pre-Phase-8 `[variant_id, quantity]` map shape
    // would have thrown all but one of them away.
    totals.set(level.variant_id, (totals.get(level.variant_id) ?? 0) + Number(level.quantity))
  }
  return totals
}

/**
 * Current stock for a single variant, scoped the same way as stockByVariant.
 * Returns 0 when no movement has ever been recorded for it at that shop —
 * a variant with no ledger row genuinely has none on the shelf.
 */
export async function stockForVariant(
  client: any,
  req: Request,
  variantId: string,
): Promise<number> {
  const levels = await client.variant_stock_levels.findMany({
    where: { variant_id: variantId, ...storeScopeWhere(req) },
  })
  return levels.reduce((total: number, level: any) => total + Number(level.quantity), 0)
}
