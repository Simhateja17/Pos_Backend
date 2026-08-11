import { describe, expect, it } from 'vitest'
import {
  CustomerIdentityConflictError,
  createCustomer,
  findOrCreateCustomer,
} from '../../src/lib/customers'

type Row = {
  id: string
  tenant_id: string
  name: string | null
  billing_name?: string | null
  phone: string | null
  email: string | null
}

function makeFakeTx(seed: Row[] = []) {
  const rows = [...seed]
  let nextId = rows.length + 1
  const matches = (row: Row, where: any) => {
    if (row.tenant_id !== where.tenant_id) return false
    return where.OR.some((clause: any) => {
      if (clause.phone) return row.phone === clause.phone
      if (clause.email) return row.email?.toLowerCase() === clause.email.equals.toLowerCase()
      return false
    })
  }
  return {
    customers: {
      findMany: async ({ where }: any) => rows.filter((row) => matches(row, where)),
      findFirst: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? rows.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `customer-${nextId++}`, ...data }
        rows.push(row)
        return row
      },
    },
    rows,
  }
}

describe('customer deduplication policy', () => {
  it('allows the same normalized identity in different tenants', async () => {
    const tx = makeFakeTx([
      { id: 'a-1', tenant_id: 'tenant-a', name: 'A', phone: '+919876543210', email: null },
    ])

    const customer = await findOrCreateCustomer(tx, 'tenant-b', { phone: '09876543210' })

    expect(customer?.id).toBe('customer-2')
    expect(tx.rows).toHaveLength(2)
    expect(tx.rows[1].tenant_id).toBe('tenant-b')
  })

  it('reuses one existing customer when either normalized identity matches', async () => {
    const tx = makeFakeTx([
      { id: 'customer-1', tenant_id: 'tenant-a', name: 'A', phone: '+919876543210', email: 'a@example.com' },
    ])

    const byPhone = await findOrCreateCustomer(tx, 'tenant-a', { phone: '09876543210' })
    const byEmail = await findOrCreateCustomer(tx, 'tenant-a', { email: ' A@EXAMPLE.COM ' })

    expect(byPhone?.id).toBe('customer-1')
    expect(byEmail?.id).toBe('customer-1')
    expect(tx.rows).toHaveLength(1)
  })

  it('returns a conflict when phone and email point to different existing customers', async () => {
    const tx = makeFakeTx([
      { id: 'customer-phone', tenant_id: 'tenant-a', name: 'Phone', phone: '+919876543210', email: null },
      { id: 'customer-email', tenant_id: 'tenant-a', name: 'Email', phone: null, email: 'buyer@example.com' },
    ])

    await expect(
      findOrCreateCustomer(tx, 'tenant-a', { phone: '09876543210', email: 'BUYER@example.com' }),
    ).rejects.toBeInstanceOf(CustomerIdentityConflictError)
    expect(tx.rows).toHaveLength(2)
  })

  it('rejects manual creation when one tenant already owns the phone/email', async () => {
    const tx = makeFakeTx([
      { id: 'customer-1', tenant_id: 'tenant-a', name: 'A', phone: '+919876543210', email: null },
    ])

    await expect(createCustomer(tx, 'tenant-a', { billingName: 'Duplicate', phone: '9876543210' }))
      .rejects.toBeInstanceOf(CustomerIdentityConflictError)
  })
})
