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
  })
  .openapi('PinSwitchRequest')

export const PinSwitchResponseSchema = z
  .object({
    operatorToken: z.string(),
    staff: z.object({
      id: z.string(),
      role: z.enum(['owner', 'manager', 'cashier']),
    }),
  })
  .openapi('PinSwitchResponse')

export type PinSwitchInput = z.infer<typeof PinSwitchSchema>
export type PinSwitchResponse = z.infer<typeof PinSwitchResponseSchema>
