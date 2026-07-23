import type { NextFunction, Request, Response } from 'express'

interface HttpError extends Error {
  status?: number
}

/**
 * Centralized Express error-handling middleware. Must be registered LAST
 * (after all routes) — Express identifies error middleware by its 4-argument
 * signature. Express 5 auto-forwards rejected promises from async route
 * handlers/middleware here, so no `express-async-errors` package is needed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction) {
  // eslint-disable-next-line no-console
  console.error(err)
  const status = err.status ?? 500
  res.status(status).json({ error: err.message ?? 'Internal server error' })
}
