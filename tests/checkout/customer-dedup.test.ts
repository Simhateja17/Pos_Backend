import { describe, it, expect, beforeEach } from 'vitest'
import { CustomerValidationError, findOrCreateCustomer } from '../../src/lib/customers'

function makeFakeTx() {
  const rows: Array<{ id: string; tenant_id: string; name: string | null; phone: string | null; email: string | null }> = []
  let nextId = 1
  return {
    customers: {
      findFirst: async ({ where }: any) => {
        if (where.id) {
          return rows.find((r) => r.tenant_id === where.tenant_id && r.id === where.id) ?? null
        }
        return (
          rows.find((r) => {
            if (r.tenant_id !== where.tenant_id) return false
            return where.OR.some((clause: any) => {
              if (clause.phone) return r.phone === clause.phone
              if (clause.email) return r.email?.toLowerCase() === clause.email.equals.toLowerCase()
              return false
            })
          }) ?? null
        )
      },
      create: async ({ data }: any) => {
        const row = { id: `cust-${nextId++}`, ...data }
        rows.push(row)
        return row
      },
    },
    _rows: rows,
  }
}

describe('findOrCreateCustomer dedup', () => {
  const tenantId = 'tenant-1'
  let tx: ReturnType<typeof makeFakeTx>

  beforeEach(() => {
    tx = makeFakeTx()
  })

  it('creates a new customer on first phone submission', async () => {
    const customer = await findOrCreateCustomer(tx, tenantId, { phone: '5551234567' })
    expect(customer).not.toBeNull()
    expect(tx._rows.length).toBe(1)
  })

  it('reuses the existing row for a repeat phone match (CUST-01 dedup invariant)', async () => {
    const first = await findOrCreateCustomer(tx, tenantId, { phone: '5551234567', name: 'Alex' })
    const second = await findOrCreateCustomer(tx, tenantId, { phone: '5551234567' })
    expect(second!.id).toBe(first!.id)
    expect(tx._rows.length).toBe(1)
  })

  it('reuses the existing row for a case-insensitive repeat email match', async () => {
    const first = await findOrCreateCustomer(tx, tenantId, { email: 'A@Example.com' })
    const second = await findOrCreateCustomer(tx, tenantId, { email: 'a@example.com' })
    expect(second!.id).toBe(first!.id)
    expect(tx._rows.length).toBe(1)
  })

  it('attaches a selected existing customer by id instead of treating the sale as walk-in', async () => {
    const first = await findOrCreateCustomer(tx, tenantId, { phone: '5551234567', name: 'Alex' })
    const selected = await findOrCreateCustomer(tx, tenantId, { id: first!.id })

    expect(selected?.id).toBe(first?.id)
    expect(tx._rows.length).toBe(1)
  })

  it('rejects a selected customer outside the active tenant', async () => {
    const otherTenantCustomer = await findOrCreateCustomer(tx, 'tenant-2', { phone: '5551234567' })

    await expect(findOrCreateCustomer(tx, tenantId, { id: otherTenantCustomer!.id }))
      .rejects.toBeInstanceOf(CustomerValidationError)
  })

  it('returns null and creates nothing for an anonymous walk-in (no phone/email)', async () => {
    expect(await findOrCreateCustomer(tx, tenantId, undefined)).toBeNull()
    expect(await findOrCreateCustomer(tx, tenantId, {})).toBeNull()
    expect(tx._rows.length).toBe(0)
  })
})
