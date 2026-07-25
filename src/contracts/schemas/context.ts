import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/** Safe display identity for the authenticated India application shell. */
export const AppContextSchema = z
  .object({
    staff: z.object({
      id: z.string().uuid().nullable(),
      name: z.string().nullable(),
      role: z.enum(['owner', 'manager', 'cashier']),
    }),
    tenant: z.object({
      id: z.string().uuid(),
      businessName: z.string(),
      locality: z.string().nullable(),
    }),
    onboarding: z.object({
      step: z.number().int().min(0).max(8),
      completed: z.boolean(),
    }),
  })
  .openapi('AppContext')

export type AppContext = z.infer<typeof AppContextSchema>
