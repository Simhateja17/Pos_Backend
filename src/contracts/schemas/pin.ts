import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// extendZodWithOpenApi(z) is internally guarded/idempotent (see
// schemas/member.ts's comment) — calling it here too removes an implicit
// "auth.ts must be imported first" ordering dependency for this module.
extendZodWithOpenApi(z)

export const PinSwitchSchema = z
  .object({
    staffId: z.string(),
    pin: z.string(),
    /** Approval and management sessions must not interrupt the cashier
     * currently operating the counter. */
    sessionType: z.enum(['register', 'approval', 'management']).default('register'),
  })
  .openapi('PinSwitchRequest')

export const PinSwitchResponseSchema = z
  .object({
    operatorToken: z.string(),
    staff: z.object({
      id: z.string(),
      role: z.enum(['owner', 'manager', 'cashier']),
      mustChangePin: z.boolean(),
    }),
  })
  .openapi('PinSwitchResponse')

export const ChangeOperatorPinSchema = z
  .object({
    pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
  })
  .openapi('ChangeOperatorPinRequest')

export const StaffSessionSchema = z
  .object({
    id: z.string(),
    staffId: z.string(),
    staffName: z.string().nullable(),
    terminalId: z.string().nullable(),
    terminalName: z.string().nullable(),
    shiftId: z.string().nullable(),
    loggedInAt: z.string(),
    loggedOutAt: z.string().nullable(),
    logoutReason: z.string().nullable(),
    lastSeenAt: z.string(),
  })
  .openapi('StaffSession')

export type PinSwitchInput = z.infer<typeof PinSwitchSchema>
export type PinSwitchResponse = z.infer<typeof PinSwitchResponseSchema>
