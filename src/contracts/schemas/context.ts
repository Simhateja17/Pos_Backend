import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

/** Safe display identity for the authenticated India application shell. */
export const AppContextSchema = z
  .object({
    /** Plan access for the tenant; the server still enforces 402 on operational routes. */
    subscription: z.object({
      accessAllowed: z.boolean(),
      graceUntil: z.string().datetime().nullable(),
    }).optional(),
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
    store: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        locality: z.string().nullable(),
        combinedTaxRatePercent: z.string(),
        taxTreatment: z.enum(['cgst_sgst', 'igst']),
      })
      .nullable(),
    stores: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        city: z.string().nullable(),
        state: z.string().nullable(),
        country: z.string(),
        isActive: z.boolean(),
        isOwnStore: z.boolean(),
      }),
    ).default([]),
    region: z.enum(['IN', 'US']).nullable(),
    permissions: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
    onboarding: z.object({
      step: z.number().int().min(0).max(8),
      completed: z.boolean(),
    }),
    operator: z.object({
      state: z.enum(['absent', 'valid', 'invalid', 'locked']),
      staff: z.object({
        id: z.string().uuid(),
        role: z.enum(['owner', 'manager', 'cashier']),
        storeId: z.string().uuid().nullable(),
        mustChangePin: z.boolean(),
      }).nullable(),
      registerLocked: z.boolean(),
      mustChangePin: z.boolean(),
    }).optional(),
  })
  .openapi('AppContext')

export type AppContext = z.infer<typeof AppContextSchema>
