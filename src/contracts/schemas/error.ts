import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/** Safe envelope for mobile and other non-cookie clients. */
export const ApiErrorEnvelopeSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryAfterSeconds: z.number().int().positive().optional(),
    requestId: z.string().uuid().optional(),
  })
  .openapi('ApiErrorEnvelope')

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'SESSION_REVOKED'
  | 'REFRESH_REJECTED'
  | 'RATE_LIMITED'
  | 'NO_MEMBERSHIP'
  | 'OPERATOR_INVALID'
  | 'REGISTER_LOCKED'
  | 'STORE_FORBIDDEN'
  | 'STORE_CLOSED'
  | 'SUBSCRIPTION_REQUIRED'
  | 'SERVICE_UNAVAILABLE'

export function errorEnvelope(code: ApiErrorCode | string, message: string, retryAfterSeconds?: number, requestId?: string) {
  return {
    code,
    message,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(requestId ? { requestId } : {}),
  }
}
