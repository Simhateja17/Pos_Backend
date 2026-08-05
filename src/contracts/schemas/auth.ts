import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// extendZodWithOpenApi(z) is called exactly once here, at process load of this
// file. 01-08's openapi.ts imports these schemas without calling it again.
extendZodWithOpenApi(z)

/**
 * Signup is the single capture point for business identity. Onboarding steps 1
 * ("Business Identity") and 2 ("GST & Legal Compliance") used to re-ask these
 * details a second time and write them to a separate JSON blob, leaving two
 * unreconciled names for the same business.
 *
 * Every GST field is optional: registration is not mandatory in India below the
 * ₹40L (goods) / ₹20L (services) turnover threshold, so requiring them would
 * block legitimate small retailers from reaching a working till.
 */
export const SignupSchema = z
  .object({
    email: z.string().email(),
    /** 6-digit code from POST /auth/otp/request (purpose: 'signup'), verified server-side via Supabase Auth. */
    otp: z.string().length(6),
    ownerName: z.string().min(1),
    /** Legal registered name — appears on invoices and tax records. */
    businessName: z.string().min(1),
    /** Brand / trading name, when it differs from the registered name. */
    tradeName: z.string().min(1).max(200).optional(),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().default('IN'),
    /** GSTIN. Stored in tenants.tax_id. */
    taxId: z.string().max(15).optional(),
    gstStatus: z.enum(['regular', 'composition', 'unregistered']).optional(),
    pan: z.string().max(10).optional(),
    placeOfSupply: z.string().max(100).optional(),
  })
  .openapi('SignupRequest')

export const LoginSchema = z
  .object({
    email: z.string().email(),
    /** 6-digit code from POST /auth/otp/request (purpose: 'login'), verified server-side via Supabase Auth. */
    otp: z.string().length(6),
  })
  .openapi('LoginRequest')

export const OtpRequestSchema = z
  .object({
    email: z.string().email(),
    purpose: z.enum(['login', 'signup']),
  })
  .openapi('OtpRequestRequest')

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
export type OtpRequestInput = z.infer<typeof OtpRequestSchema>
export type AuthResponse = z.infer<typeof AuthResponseSchema>
export type SetPinInput = z.infer<typeof SetPinSchema>
