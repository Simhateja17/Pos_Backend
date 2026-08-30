// CUST-01: dedup-safe customer identity normalization, find-or-create, CRUD
// helpers and search. Contains no DB import of its own — operates on whatever
// client object it is passed, so it works both from inside a request-scoped
// transaction (sales.ts's checkout flow, via forTenantTransaction's `tx`) and
// from a plain tenant-scoped client (customers.ts read routes).

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const INDIA_STATE_CODE_PATTERN = /^(0[1-9]|[12][0-9]|3[0-8]|97)$/
const INDIA_POSTAL_CODE_PATTERN = /^[1-9][0-9]{5}$/

export class CustomerValidationError extends Error {
  readonly code = 'CUSTOMER_VALIDATION'

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'CustomerValidationError'
  }
}

export class CustomerIdentityConflictError extends Error {
  readonly code = 'CUSTOMER_IDENTITY_CONFLICT'

  constructor(message = 'A customer with this phone or email already exists') {
    super(message)
    this.name = 'CustomerIdentityConflictError'
  }
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = clean(value)
  return normalized ? normalized.toLowerCase() : null
}

/**
 * Canonicalizes the phone forms commonly entered by Indian retailers:
 * `98765 43210`, `09876543210`, `919876543210`, and `+91 98765 43210`
 * all become `+919876543210`. International numbers remain E.164-shaped
 * (`+` plus digits), but this module does not pretend to validate carrier
 * reachability.
 */
export function normalizePhone(value: string | null | undefined): string | null {
  const normalized = clean(value)
  if (!normalized) return null

  const digits = normalized.replace(/[^0-9]/g, '')
  if (digits.length < 7 || digits.length > 15) {
    throw new CustomerValidationError('Enter a valid phone number', 'phone')
  }

  if (digits.length === 10) return `+91${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`
  if (digits.startsWith('00')) return `+${digits.slice(2)}`
  return `+${digits}`
}

export function normalizeGstin(value: string | null | undefined): string | null {
  const normalized = clean(value)?.toUpperCase() ?? null
  if (!normalized) return null
  if (!GSTIN_PATTERN.test(normalized)) {
    throw new CustomerValidationError('Enter a valid 15-character GSTIN', 'gstin')
  }
  return normalized
}

export function normalizeStateCode(value: string | null | undefined): string | null {
  const normalized = clean(value)
  if (!normalized) return null
  if (!INDIA_STATE_CODE_PATTERN.test(normalized)) {
    throw new CustomerValidationError('Use a valid two-digit Indian state code', 'stateCode')
  }
  return normalized
}

export function normalizePostalCode(value: string | null | undefined, country: string): string | null {
  const normalized = clean(value)
  if (!normalized) return null
  if (country === 'IN' && !INDIA_POSTAL_CODE_PATTERN.test(normalized)) {
    throw new CustomerValidationError('Use a valid six-digit Indian PIN code', 'postalCode')
  }
  return normalized
}

export type CustomerWriteInput = {
  name?: string | null
  billingName?: string | null
  phone?: string | null
  email?: string | null
  gstin?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  stateCode?: string | null
  postalCode?: string | null
  country?: string | null
  notes?: string | null
  creditLimit?: string | null
}

export type NormalizedCustomerInput = {
  billingName: string | null
  phone: string | null
  email: string | null
  gstin: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  stateCode: string | null
  postalCode: string | null
  country: string
  notes: string | null
}

export function normalizeCustomerInput(input: CustomerWriteInput): NormalizedCustomerInput {
  const country = (clean(input.country) ?? 'IN').toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new CustomerValidationError('Country must be a two-letter code', 'country')
  }

  const billingName = clean(input.billingName !== undefined ? input.billingName : input.name)
  const phone = normalizePhone(input.phone)
  const email = normalizeEmail(input.email)
  if (!phone && !email) {
    throw new CustomerValidationError('At least one of phone or email is required', 'phone')
  }

  const gstin = normalizeGstin(input.gstin)
  const stateCode = normalizeStateCode(input.stateCode)
  const postalCode = normalizePostalCode(input.postalCode, country)

  return {
    billingName,
    phone,
    email,
    gstin,
    addressLine1: clean(input.addressLine1),
    addressLine2: clean(input.addressLine2),
    city: clean(input.city),
    stateCode,
    postalCode,
    country,
    notes: clean(input.notes),
  }
}

function identityWhere(tenantId: string, input: Pick<NormalizedCustomerInput, 'phone' | 'email'>) {
  return {
    tenant_id: tenantId,
    OR: [
      input.phone ? { phone: input.phone } : undefined,
      input.email ? { email: { equals: input.email, mode: 'insensitive' } } : undefined,
    ].filter((clause): clause is NonNullable<typeof clause> => !!clause),
  }
}

async function findIdentityMatches(
  client: any,
  tenantId: string,
  input: Pick<NormalizedCustomerInput, 'phone' | 'email'>,
): Promise<any[]> {
  const where = identityWhere(tenantId, input)
  if (where.OR.length === 0) return []

  // The fallback keeps the checkout unit seam compatible with older test
  // doubles while production and route tests use findMany to detect the
  // phone/email collision case instead of selecting an arbitrary row.
  if (typeof client.customers.findMany === 'function') {
    return (await client.customers.findMany({ where, take: 3 })) ?? []
  }
  const row = await client.customers.findFirst({ where })
  return row ? [row] : []
}

function customerData(tenantId: string, input: NormalizedCustomerInput) {
  return {
    tenant_id: tenantId,
    // `name` is the compatibility field used by checkout, returns and older
    // generated clients. `billing_name` is the India profile field. Keeping
    // both equal avoids a split identity while the final integrator refreshes
    // Prisma and the generated API artifacts.
    name: input.billingName,
    billing_name: input.billingName,
    phone: input.phone,
    email: input.email,
    gstin: input.gstin,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2,
    city: input.city,
    state_code: input.stateCode,
    postal_code: input.postalCode,
    country: input.country,
    notes: input.notes,
  }
}

function distinctIds(rows: any[]): string[] {
  return [...new Set(rows.map((row) => row.id).filter(Boolean))]
}

function ensureNoIdentityCollision(rows: any[], currentCustomerId?: string): void {
  const otherIds = distinctIds(rows).filter((id) => id !== currentCustomerId)
  if (otherIds.length > 1) {
    throw new CustomerIdentityConflictError(
      'Phone and email identify different existing customers; choose one identity instead of merging them',
    )
  }
  if (otherIds.length === 1) {
    throw new CustomerIdentityConflictError()
  }
}

export async function createCustomer(
  tx: any,
  tenantId: string,
  input: CustomerWriteInput,
): Promise<any> {
  const normalized = normalizeCustomerInput(input)
  const matches = await findIdentityMatches(tx, tenantId, normalized)
  if (matches.length > 0) {
    ensureNoIdentityCollision(matches)
    throw new CustomerIdentityConflictError()
  }
  return tx.customers.create({ data: customerData(tenantId, normalized) })
}

export async function updateCustomer(
  tx: any,
  tenantId: string,
  customerId: string,
  input: CustomerWriteInput,
): Promise<any | null> {
  const existing = await tx.customers.findFirst({ where: { id: customerId } })
  if (!existing) return null

  const normalized = normalizeCustomerInput({
    billingName: input.billingName !== undefined ? input.billingName : (existing.billing_name ?? existing.name),
    phone: input.phone !== undefined ? input.phone : existing.phone,
    email: input.email !== undefined ? input.email : existing.email,
    gstin: input.gstin !== undefined ? input.gstin : existing.gstin,
    addressLine1: input.addressLine1 !== undefined ? input.addressLine1 : existing.address_line1,
    addressLine2: input.addressLine2 !== undefined ? input.addressLine2 : existing.address_line2,
    city: input.city !== undefined ? input.city : existing.city,
    stateCode: input.stateCode !== undefined ? input.stateCode : existing.state_code,
    postalCode: input.postalCode !== undefined ? input.postalCode : existing.postal_code,
    country: input.country !== undefined ? input.country : existing.country,
    notes: input.notes !== undefined ? input.notes : existing.notes,
  })
  const matches = await findIdentityMatches(tx, tenantId, normalized)
  ensureNoIdentityCollision(matches, customerId)

  return tx.customers.update({
    where: { id: customerId },
    data: {
      name: normalized.billingName,
      billing_name: normalized.billingName,
      phone: normalized.phone,
      email: normalized.email,
      gstin: normalized.gstin,
      address_line1: normalized.addressLine1,
      address_line2: normalized.addressLine2,
      city: normalized.city,
      state_code: normalized.stateCode,
      postal_code: normalized.postalCode,
      country: normalized.country,
      notes: normalized.notes,
      ...(input.creditLimit !== undefined ? { credit_limit: input.creditLimit } : {}),
    },
  })
}

export function customerSearchTerms(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const terms = new Set([trimmed])
  const digits = trimmed.replace(/[^0-9]/g, '')
  if (digits) terms.add(digits)
  try {
    const phone = normalizePhone(trimmed)
    if (phone) terms.add(phone)
  } catch {
    // A name/email query is still a valid search even if it is not phone-like.
  }
  return [...terms]
}

export function customerSearchWhere(query: string): any[] {
  const terms = customerSearchTerms(query)
  return terms.flatMap((term) => [
    { phone: { contains: term } },
    { email: { contains: term, mode: 'insensitive' } },
    { name: { contains: term, mode: 'insensitive' } },
    { billing_name: { contains: term, mode: 'insensitive' } },
  ])
}

// CUST-01: checkout and manual create share this normalization + collision
// policy. Anonymous walk-in sales remain allowed and do not create a row.

export async function findOrCreateCustomer(
  tx: any,
  tenantId: string,
  input: { id?: string; name?: string; phone?: string; email?: string } | undefined,
): Promise<{ id: string } | null> {
  if (!input) {
    // Anonymous walk-in sale — allowed per CUST-01's discretion resolution.
    // No customer row is created.
    return null
  }

  // Checkout sends only the id when a cashier selects an existing customer.
  // Resolve that identity explicitly before falling back to the phone/email
  // find-or-create path; otherwise every selected customer is misclassified
  // as an anonymous walk-in sale.
  if (input.id) {
    const existing = await tx.customers.findFirst({ where: { id: input.id, tenant_id: tenantId } })
    if (!existing) throw new CustomerValidationError('Selected customer could not be found', 'id')
    return existing
  }

  if (!input.phone && !input.email) {
    // Anonymous walk-in sale — allowed per CUST-01's discretion resolution.
    // No customer row is created.
    return null
  }

  const normalized = normalizeCustomerInput({
    billingName: input.name,
    phone: input.phone,
    email: input.email,
  })
  const matches = await findIdentityMatches(tx, tenantId, normalized)
  if (matches.length > 0) {
    const ids = distinctIds(matches)
    if (ids.length > 1) {
      throw new CustomerIdentityConflictError(
        'Phone and email identify different existing customers; choose one identity instead of merging them',
      )
    }
    return matches[0]
  }

  return tx.customers.create({ data: customerData(tenantId, normalized) })
}

export async function searchCustomers(
  client: any,
  query: string,
): Promise<Array<{
  id: string
  name: string | null
  billingName: string | null
  phone: string | null
  email: string | null
  createdAt: Date
}>> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const rows = await client.customers.findMany({
    where: { OR: customerSearchWhere(trimmed) },
    orderBy: { created_at: 'desc' },
    take: 20,
  })
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name ?? r.billing_name ?? null,
    billingName: r.billing_name ?? r.name ?? null,
    phone: r.phone,
    email: r.email,
    createdAt: r.created_at,
  }))
}
