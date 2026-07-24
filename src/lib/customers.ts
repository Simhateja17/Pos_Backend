// CUST-01: dedup-safe customer find-or-create + search. Contains no DB import
// of its own — operates on whatever client object it is passed, so it works
// both from inside a request-scoped transaction (sales.ts's checkout flow,
// via forTenantTransaction's `tx`) and from a plain tenant-scoped client
// (customers.ts's GET /customers?search= route).

export async function findOrCreateCustomer(
  tx: any,
  tenantId: string,
  input: { name?: string; phone?: string; email?: string } | undefined,
): Promise<{ id: string } | null> {
  if (!input || (!input.phone && !input.email)) {
    // Anonymous walk-in sale — allowed per CUST-01's discretion resolution.
    // No customer row is created.
    return null
  }

  const normalizedEmail = input.email ? input.email.trim().toLowerCase() : undefined

  // Check-before-insert, never blindly insert (RESEARCH.md Pitfall 5) — this
  // is what makes findOrCreateCustomer's dedup invariant provable, backed by
  // 03-01's unique partial indexes as DB-level defense-in-depth.
  const existing = await tx.customers.findFirst({
    where: {
      tenant_id: tenantId,
      OR: [
        input.phone ? { phone: input.phone } : undefined,
        normalizedEmail ? { email: { equals: normalizedEmail, mode: 'insensitive' } } : undefined,
      ].filter((clause): clause is NonNullable<typeof clause> => !!clause),
    },
  })
  if (existing) return existing

  return tx.customers.create({
    data: {
      tenant_id: tenantId,
      name: input.name ?? null,
      phone: input.phone ?? null,
      email: normalizedEmail ?? null,
    },
  })
}

export async function searchCustomers(
  client: any,
  query: string,
): Promise<Array<{ id: string; name: string | null; phone: string | null; email: string | null; createdAt: Date }>> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const rows = await client.customers.findMany({
    where: {
      OR: [
        { phone: { contains: trimmed } },
        { email: { contains: trimmed, mode: 'insensitive' } },
        { name: { contains: trimmed, mode: 'insensitive' } },
      ],
    },
    orderBy: { created_at: 'desc' },
    take: 20,
  })
  return rows.map((r: any) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, createdAt: r.created_at }))
}
