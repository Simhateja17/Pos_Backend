import { Prisma } from '@prisma/client'

/**
 * Resolve sparse store price overrides in one query. A missing override is not
 * an error: it deliberately means "use the catalog price".
 */
export async function effectivePricesForVariants(
  tx: any,
  storeId: string,
  variants: Array<{ id: string; price: Prisma.Decimal }>,
): Promise<Prisma.Decimal[]> {
  const overrides = await tx.variant_store_prices.findMany({
    where: { store_id: storeId, variant_id: { in: variants.map((variant) => variant.id) } },
    select: { variant_id: true, price: true },
  })
  const byVariant = new Map<string, Prisma.Decimal>(
    overrides.map((row: any) => [row.variant_id, new Prisma.Decimal(row.price)]),
  )
  return variants.map((variant) => byVariant.get(variant.id) ?? new Prisma.Decimal(variant.price))
}
