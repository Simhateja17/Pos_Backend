import { beforeEach, describe, expect, it, vi } from 'vitest'

const suppressionRows: any[] = []
const emailLogRows: any[] = []

vi.mock('../../src/db/tenantClient', () => ({
  forTenant: vi.fn(() => ({
    email_suppressions: {
      findMany: vi.fn(async () => suppressionRows),
      create: vi.fn(async ({ data }: any) => {
        suppressionRows.push({ id: `sup-${suppressionRows.length}`, ...data })
        return suppressionRows.at(-1)
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = suppressionRows.find((entry) => entry.id === where.id)
        Object.assign(row, data)
        return row
      }),
      delete: vi.fn(async ({ where }: any) => {
        const index = suppressionRows.findIndex((entry) => entry.id === where.id)
        return suppressionRows.splice(index, 1)[0]
      }),
    },
    email_log: {
      create: vi.fn(async ({ data }: any) => {
        emailLogRows.push({ id: `log-${emailLogRows.length}`, ...data })
        return emailLogRows.at(-1)
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = emailLogRows.find((entry) => entry.id === where.id)
        Object.assign(row, data)
        return row
      }),
      findMany: vi.fn(async () => emailLogRows),
    },
  })),
}))

const sendMock = vi.fn(async () => ({ ok: true as const }))
vi.mock('../../src/lib/receiptEmail', () => ({ sendReceiptEmail: sendMock }))

const TENANT = 'tenant-1'

async function service() {
  return import('../../src/services/email')
}

function send(kind: 'receipt' | 'offer', to = 'shopper@example.com') {
  return service().then((mod) =>
    mod.sendLoggedEmail({
      tenantId: TENANT,
      kind,
      to,
      saleId: null,
      subject: 'Subject',
      businessName: 'Shop',
      totalAmount: '100.00',
    }),
  )
}

describe('email suppression semantics (COMMS-01)', () => {
  beforeEach(() => {
    suppressionRows.length = 0
    emailLogRows.length = 0
    sendMock.mockClear()
    sendMock.mockResolvedValue({ ok: true as const })
  })

  it('sends a receipt to someone who unsubscribed — a receipt is not marketing', async () => {
    const { suppress } = await service()
    await suppress(TENANT, 'shopper@example.com', 'unsubscribed')

    const outcome = await send('receipt')

    expect(outcome.status).toBe('sent')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('does not send an offer to someone who unsubscribed', async () => {
    const { suppress } = await service()
    await suppress(TENANT, 'shopper@example.com', 'unsubscribed')

    const outcome = await send('offer')

    expect(outcome.status).toBe('suppressed')
    expect(sendMock).not.toHaveBeenCalled()
    expect(emailLogRows.at(-1)).toMatchObject({ status: 'suppressed', kind: 'offer' })
  })

  it('stops even a receipt once the address has hard bounced', async () => {
    const { suppress } = await service()
    await suppress(TENANT, 'shopper@example.com', 'bounced')

    const outcome = await send('receipt')

    expect(outcome.status).toBe('suppressed')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('matches a suppressed address regardless of case or surrounding spaces', async () => {
    const { suppress } = await service()
    await suppress(TENANT, 'Shopper@Example.com', 'complained')

    const outcome = await send('receipt', '  SHOPPER@example.COM  ')

    expect(outcome.status).toBe('suppressed')
  })

  it('logs a suppressed attempt rather than dropping it silently', async () => {
    const { suppress } = await service()
    await suppress(TENANT, 'shopper@example.com', 'bounced')
    await send('receipt')

    expect(emailLogRows).toHaveLength(1)
    expect(emailLogRows[0].error_message).toContain('bounced')
  })

  it('records a provider failure against the log row instead of throwing', async () => {
    sendMock.mockResolvedValue({ ok: false, error: 'provider down' } as any)

    const outcome = await send('receipt')

    expect(outcome.status).toBe('failed')
    expect(emailLogRows.at(-1)).toMatchObject({ status: 'failed', error_message: 'provider down' })
  })

  it('never throws when the provider throws — a sale must not fail because of email', async () => {
    sendMock.mockRejectedValue(new Error('socket hang up') as never)

    const outcome = await send('receipt')

    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toContain('socket hang up')
  })

  it('a bounce event suppresses the address so the next sale does not retry it', async () => {
    const { applyDeliveryEvent } = await service()
    await send('receipt')

    await applyDeliveryEvent(TENANT, { recipient: 'shopper@example.com', type: 'bounced' })

    expect(emailLogRows.at(-1)).toMatchObject({ status: 'bounced' })
    expect(suppressionRows).toHaveLength(1)

    sendMock.mockClear()
    const second = await send('receipt')
    expect(second.status).toBe('suppressed')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('a delivered event does not suppress anything', async () => {
    const { applyDeliveryEvent } = await service()
    await send('receipt')

    await applyDeliveryEvent(TENANT, { recipient: 'shopper@example.com', type: 'delivered' })

    expect(emailLogRows.at(-1)).toMatchObject({ status: 'delivered' })
    expect(suppressionRows).toHaveLength(0)
  })

  it('allows an address again once the suppression is removed', async () => {
    const { suppress, unsuppress } = await service()
    await suppress(TENANT, 'shopper@example.com', 'unsubscribed')
    expect(await unsuppress(TENANT, 'SHOPPER@example.com')).toBe(true)

    const outcome = await send('offer')
    expect(outcome.status).toBe('sent')
  })
})
