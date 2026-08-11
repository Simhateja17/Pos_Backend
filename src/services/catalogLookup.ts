/**
 * The exact lookup used by checkout barcode/SKU search and the guided scanner
 * test.  Keep this as one indexed query: `(tenant_id, barcode)` and
 * `(tenant_id, sku)` are unique indexes, and the caller is always a
 * tenant-scoped Prisma client.
 */
export async function findExactVariant(client: any, input: string, tenantId?: string) {
  const value = input.trim()
  if (!value) return null

  return client.variants.findFirst({
    where: {
      ...(tenantId ? { tenant_id: tenantId } : {}),
      OR: [
        { barcode: value },
        { sku: { equals: value, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      product_id: true,
      sku: true,
      barcode: true,
      products: { select: { name: true } },
    },
  })
}
