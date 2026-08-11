import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const SetupStepIdSchema = z
  .enum(['store_profile', 'owner_pin', 'team', 'products', 'counter', 'device_pairing', 'scanner'])
  .openapi('SetupStepId')

export const SetupStepStatusSchema = z
  .enum(['complete', 'incomplete', 'blocked', 'unavailable'])
  .openapi('SetupStepStatus')

export const TeamModeSchema = z.enum(['staffed', 'solo_owner']).openapi('SetupTeamMode')
export const ScannerChoiceSchema = z
  .enum(['verified', 'no_scanner', 'configure_later'])
  .openapi('SetupScannerChoice')

export const SetupResolutionSchema = z
  .discriminatedUnion('decision', [
    z.object({ decision: z.literal('team_mode'), value: TeamModeSchema }).strict(),
    z
      .object({
        decision: z.literal('scanner_choice'),
        // `verified` is only written by the scanner-test endpoint after an
        // exact catalog match. The frontend cannot self-attest a scan.
        value: z.enum(['no_scanner', 'configure_later']),
      })
      .strict(),
  ])
  .openapi('SetupResolutionRequest')

export const ScannerTestRequestSchema = z
  .object({
    scannedValue: z.string().trim().min(1).max(64),
  })
  .strict()
  .openapi('ScannerTestRequest')

export const TourStatusSchema = z
  .enum(['not_started', 'in_progress', 'completed', 'skipped'])
  .openapi('TourStatus')

export const TourProgressRequestSchema = z
  .object({
    status: TourStatusSchema,
    lastStep: z.string().trim().max(80).nullable().optional(),
    seenSteps: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  })
  .strict()
  .openapi('TourProgressRequest')

export const SetupStepSchema = z
  .object({
    id: SetupStepIdSchema,
    title: z.string(),
    description: z.string(),
    status: SetupStepStatusSchema,
    complete: z.boolean(),
    required: z.boolean(),
    skippable: z.boolean(),
    billingBlocking: z.boolean(),
    dependsOn: z.array(SetupStepIdSchema),
    actionHref: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi('SetupStep')

export const TourProgressSchema = z
  .object({
    status: TourStatusSchema,
    lastStep: z.string().nullable(),
    seenSteps: z.array(z.string()),
    startedAt: z.string().datetime().nullable(),
    skippedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .openapi('TourProgress')

export const SetupStateSchema = z
  .object({
    store: z.object({
      id: z.string().uuid(),
      name: z.string(),
      addressLine1: z.string().nullable(),
      addressLine2: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      postalCode: z.string().nullable(),
    }),
    steps: z.array(SetupStepSchema),
    complete: z.boolean(),
    completionPercentage: z.number().min(0).max(100),
    // Keep nullable response fields inline rather than wrapping a named
    // OpenAPI component in `allOf`; that produces an intersection which cannot
    // actually validate `null` in generated clients.
    nextAction: z.enum(['store_profile', 'owner_pin', 'team', 'products', 'counter', 'device_pairing', 'scanner']).nullable(),
    storeReady: z.boolean(),
    billingBlockers: z.array(z.string()),
    decisions: z.object({
      teamMode: z.enum(['staffed', 'solo_owner']).nullable(),
      scannerChoice: z.enum(['verified', 'no_scanner', 'configure_later']).nullable(),
      scannerVerifiedAt: z.string().datetime().nullable(),
      scannerVariantId: z.string().uuid().nullable(),
    }),
    tour: TourProgressSchema,
  })
  .openapi('SetupState')

export const ScannerTestResponseSchema = z
  .object({
    status: z.enum(['verified', 'no_match']),
    matched: z.boolean(),
    variantId: z.string().uuid().nullable(),
    sku: z.string().nullable(),
    productName: z.string().nullable(),
    message: z.string(),
  })
  .openapi('ScannerTestResponse')

export type SetupState = z.infer<typeof SetupStateSchema>
export type SetupResolution = z.infer<typeof SetupResolutionSchema>
export type ScannerTestRequest = z.infer<typeof ScannerTestRequestSchema>
export type TourProgressRequest = z.infer<typeof TourProgressRequestSchema>
