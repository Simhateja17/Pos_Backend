import { describe, it, expect, beforeEach } from 'vitest'
import { findOrCreateCustomer } from '../../src/lib/customers'

function makeFakeTx() {
  const rows: Array<{ id: string; tenant_id: string; name: string | null; phone: string | null; email: string | null }> = []
  let nextId = 1
  return {
    customers: {
      findFirst: async ({ where }: any) => {
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

  it('returns null and creates nothing for an anonymous walk-in (no phone/email)', async () => {
    expect(await findOrCreateCustomer(tx, tenantId, undefined)).toBeNull()
    expect(await findOrCreateCustomer(tx, tenantId, {})).toBeNull()
    expect(tx._rows.length).toBe(0)
  })
})
