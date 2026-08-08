import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { errorHandler } from '../../src/middleware/errorHandler'

describe('errorHandler', () => {
  it('hides database diagnostics from unexpected 500 responses', async () => {
    const app = express()
    app.get('/broken', () => {
      throw new Error('column p.category does not exist (SQLSTATE 42703)')
    })
    app.use(errorHandler)

    const response = await request(app).get('/broken')

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('Internal server error')
    expect(response.body.requestId).toEqual(expect.any(String))
    expect(JSON.stringify(response.body)).not.toContain('p.category')
    expect(JSON.stringify(response.body)).not.toContain('42703')
  })

  it('preserves an explicitly client-safe 4xx message', async () => {
    const app = express()
    app.get('/invalid', () => {
      throw Object.assign(new Error('That report is not available.'), { status: 400 })
    })
    app.use(errorHandler)

    const response = await request(app).get('/invalid')

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('That report is not available.')
  })
})
