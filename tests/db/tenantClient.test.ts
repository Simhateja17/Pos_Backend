import { beforeEach, describe, expect, it, vi } from 'vitest'

const transactionMock = vi.fn()
const executeRawMock = vi.fn()
const tenantFindFirstMock = vi.fn()

vi.mock('../../src/db/prisma', () => ({
  basePrisma: {
    $transaction: transactionMock,
    $extends: vi.fn((extension: any) => ({
      tenants: {
        findFirst: (args: unknown) => extension.query.$allModels.$allOperations({
          args,
          operation: 'findFirst',
          model: 'tenants',
        }),
      },
    })),
  },
}))

const tx = {
  $executeRaw: executeRawMock,
  tenants: { findFirst: tenantFindFirstMock },
}

describe('tenant transaction boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    transactionMock.mockReset().mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    executeRawMock.mockReset().mockResolvedValue(1)
    tenantFindFirstMock.mockReset().mockResolvedValue({ id: 'tenant-real' })
    process.env.PRISMA_TX_RETRY_BASE_MS = '1'
  })

  it('sets tenant context once for a multi-query workflow', async () => {
    const { forTenantTransaction } = await import('../../src/db/tenantClient')

    const result = await forTenantTransaction('tenant-real', async (client) => {
      const first = await client.tenants.findFirst({ where: { id: 'tenant-real' } })
      const second = await client.tenants.findFirst({ where: { id: 'tenant-real' } })
      return { first, second }
    })

    expect(result).toEqual({ first: { id: 'tenant-real' }, second: { id: 'tenant-real' } })
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(transactionMock.mock.calls[0][1]).toEqual({ maxWait: 10_000, timeout: 15_000 })
    expect(executeRawMock).toHaveBeenCalledTimes(1)
  })

  it('retries only a transaction-start P2028 before running the callback', async () => {
    const startTimeout = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' })
    transactionMock
      .mockRejectedValueOnce(startTimeout)
      .mockImplementationOnce(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    const { forTenantTransaction } = await import('../../src/db/tenantClient')

    await expect(forTenantTransaction('tenant-real', async (client) => client.tenants.findFirst({}))).resolves.toEqual({ id: 'tenant-real' })
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(executeRawMock).toHaveBeenCalledTimes(1)
  })
})
