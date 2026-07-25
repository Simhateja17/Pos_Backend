import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export const EmailKindSchema = z.enum(['receipt', 'invoice', 'offer']).openapi('EmailKind')

export const EmailLogEntrySchema = z
  .object({
    id: z.string().uuid(),
    kind: EmailKindSchema,
    recipient: z.string(),
    subject: z.string(),
    status: z.enum(['queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed']),
    errorMessage: z.string().nullable(),
    saleId: z.string().uuid().nullable(),
    attempts: z.number().int().min(0),
    createdAt: z.string().datetime(),
    lastAttemptAt: z.string().datetime().nullable(),
  })
  .openapi('EmailLogEntry')

export const EmailLogSchema = z
  .object({
    entries: z.array(EmailLogEntrySchema),
    counts: z.object({
      sent: z.number().int().min(0),
      delivered: z.number().int().min(0),
      failed: z.number().int().min(0),
      bounced: z.number().int().min(0),
      suppressed: z.number().int().min(0),
    }),
    /**
     * False when no provider API key is configured, in which case every send
     * is logged as failed and the screen should say so rather than implying a
     * delivery problem.
     */
    providerConfigured: z.boolean(),
  })
  .openapi('EmailLog')

export const SuppressionSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    reason: z.enum(['unsubscribed', 'bounced', 'complained']),
    detail: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('EmailSuppression')

export const SuppressionListSchema = z
  .object({ suppressions: z.array(SuppressionSchema) })
  .openapi('EmailSuppressionList')

export const CreateSuppressionSchema = z
  .object({
    email: z.string().email().max(320),
    reason: z.enum(['unsubscribed', 'bounced', 'complained']),
    detail: z.string().max(500).optional(),
  })
  .strict()
  .openapi('CreateEmailSuppressionRequest')

export const DeliveryEventSchema = z
  .object({
    type: z.enum(['delivered', 'bounced', 'complained']),
    recipient: z.string().email().max(320),
    providerMessageId: z.string().max(200).optional(),
    logId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('EmailDeliveryEvent')

export type EmailKind = z.infer<typeof EmailKindSchema>
