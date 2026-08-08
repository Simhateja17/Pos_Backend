import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

interface HttpError extends Error {
  status?: number
  expose?: boolean
}

/**
 * Centralized Express error-handling middleware. Must be registered LAST
 * (after all routes) — Express identifies error middleware by its 4-argument
 * signature. Express 5 auto-forwards rejected promises from async route
 * handlers/middleware here, so no `express-async-errors` package is needed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction) {
  const requestId = randomUUID()
  // eslint-disable-next-line no-console
  console.error(`[request:${requestId}]`, err)
  const status = err.status ?? 500
  const exposeMessage = status < 500 || err.expose === true
  res.status(status).json({
    error: exposeMessage ? err.message ?? 'Request failed' : 'Internal server error',
    requestId,
  })
}
