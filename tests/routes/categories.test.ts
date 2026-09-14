import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'

const categoriesFindManyMock = vi.fn()
const categoriesFindFirstMock = vi.fn()
const categoriesCreateMock = vi.fn()
const categoriesUpdateMock = vi.fn()
const categoriesDeleteMock = vi.fn()
const productsFindManyMock = vi.fn()

const client = {
  categories: {
    findMany: categoriesFindManyMock,
    findFirst: categoriesFindFirstMock,
    create: categoriesCreateMock,
    update: categoriesUpdateMock,
    delete: categoriesDeleteMock,
  },
  products: { findMany: productsFindManyMock },
}

vi.mock('../../src/db/tenantClient', () => ({ forTenant: vi.fn(() => client) }))

const categoryId = '11111111-1111-4111-8111-111111111111'

function categoryRow(name = 'Dairy') {
  return {
    id: categoryId,
    tenant_id: 'tenant-a',
    name,
    sort_order: 0,
    created_at: new Date('2026-09-13T00:00:00.000Z'),
  }
}

async function buildApp(role: 'owner' | 'manager' | 'cashier' = 'owner') {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res, next) => {
    req.user = { id: 'user-a', role, tenantId: 'tenant-a', storeId: 'store-a' }
    next()
  })
  const { default: router } = await import('../../src/routes/categories')
  app.use('/categories', router)
  return app
}

describe('category routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    categoriesFindManyMock.mockResolvedValue([])
    categoriesFindFirstMock.mockResolvedValue(categoryRow())
    categoriesCreateMock.mockResolvedValue(categoryRow())
    categoriesUpdateMock.mockImplementation(async ({ data }: any) => categoryRow(data.name ?? 'Dairy'))
    categoriesDeleteMock.mockResolvedValue(categoryRow())
    productsFindManyMock.mockResolvedValue([])
  })

  it('creates a category and returns the typed response', async () => {
    const response = await request(await buildApp()).post('/categories').send({ name: ' Dairy ' })

    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      id: categoryId,
      name: 'Dairy',
      sortOrder: 0,
      productCount: 0,
      createdAt: '2026-09-13T00:00:00.000Z',
    })
    expect(categoriesCreateMock).toHaveBeenCalledWith({
      data: { tenant_id: 'tenant-a', name: 'Dairy', sort_order: 0 },
    })
  })

  it('returns stable validation, conflict, permission, and not-found envelopes', async () => {
    const invalid = await request(await buildApp()).post('/categories').send({ name: '' })
    expect(invalid.status).toBe(400)
    expect(invalid.body).toMatchObject({ code: 'INVALID_REQUEST', message: 'Enter a category name.' })

    categoriesCreateMock.mockRejectedValueOnce({ code: 'P2002' })
    const conflict = await request(await buildApp()).post('/categories').send({ name: 'Dairy' })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ code: 'CATEGORY_CONFLICT' })

    const forbidden = await request(await buildApp('manager')).post('/categories').send({ name: 'Dairy' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body).toMatchObject({ code: 'FORBIDDEN' })

    categoriesFindFirstMock.mockResolvedValueOnce(null)
    const missing = await request(await buildApp()).patch(`/categories/${categoryId}`).send({ name: 'Fresh' })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ code: 'CATEGORY_NOT_FOUND' })
  })

  it('rejects an invalid category id before querying tenant data', async () => {
    const response = await request(await buildApp()).delete('/categories/not-a-uuid')
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(categoriesFindFirstMock).not.toHaveBeenCalled()
  })

  it('deletes only the category and reports how many products became uncategorised', async () => {
    productsFindManyMock.mockResolvedValue([{ id: 'product-1' }, { id: 'product-2' }])
    const response = await request(await buildApp()).delete(`/categories/${categoryId}`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ deleted: true, productsUncategorised: 2 })
    expect(categoriesDeleteMock).toHaveBeenCalledWith({ where: { id: categoryId } })
  })
})
