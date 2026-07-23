import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// extendZodWithOpenApi(z) is called exactly once here, at process load of this
// file. 01-08's openapi.ts imports these schemas without calling it again.
extendZodWithOpenApi(z)

export const SignupSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    ownerName: z.string().min(1),
    businessName: z.string().min(1),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().default('US'),
    taxId: z.string().optional(),
  })
  .openapi('SignupRequest')

export const LoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .openapi('LoginRequest')

export const AuthResponseSchema = z
  .object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      role: z.enum(['owner', 'manager', 'cashier']),
      tenantId: z.string().uuid(),
    }),
    session: z.object({
      accessToken: z.string(),
      refreshToken: z.string(),
    }),
  })
  .openapi('AuthResponse')

export const SetPinSchema = z
  .object({
    pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
  })
  .openapi('SetPinRequest')

export type SignupInput = z.infer<typeof SignupSchema>
export type LoginInput = z.infer<typeof LoginSchema>
export type AuthResponse = z.infer<typeof AuthResponseSchema>
export type SetPinInput = z.infer<typeof SetPinSchema>
