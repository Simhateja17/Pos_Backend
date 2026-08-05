import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

// This module can be imported directly by tests, so it owns the OpenAPI
// extension guard just like the other standalone schema modules.
extendZodWithOpenApi(z)

export const BillingRegionSchema = z.enum(['IN', 'US']).openapi('BillingRegion')
export const BillingCycleSchema = z.enum(['monthly', 'annual']).openapi('BillingCycle')
export const BillingCurrencySchema = z.enum(['INR', 'USD']).openapi('BillingCurrency')

export const BillingQuoteSchema = z
  .object({
    baseAmountMinor: z.number().int().nonnegative(),
    taxAmountMinor: z.number().int().nonnegative(),
    totalAmountMinor: z.number().int().nonnegative(),
    taxRateBps: z.number().int().nonnegative(),
    taxMode: z.enum(['included', 'exclusive']),
    taxLabel: z.string(),
  })
  .openapi('BillingQuote')

export const BillingPlanOptionSchema = z
  .object({
    key: z.string(),
    region: BillingRegionSchema,
    currency: BillingCurrencySchema,
    name: z.string(),
    description: z.string(),
    popular: z.boolean(),
    features: z.array(z.string()),
    monthly: BillingQuoteSchema,
    annual: BillingQuoteSchema,
    monthlyAvailable: z.boolean(),
    annualAvailable: z.boolean(),
    providerConfigured: z.object({ monthly: z.boolean(), annual: z.boolean() }),
  })
  .openapi('BillingPlanOption')

export const BillingPlanCatalogSchema = z
  .object({
    mode: z.enum(['test', 'live']),
    region: BillingRegionSchema,
    plans: z.array(BillingPlanOptionSchema),
  })
  .openapi('BillingPlanCatalog')

export const CreateSubscriptionSchema = z
  .object({
    planKey: z.string().trim().min(1).max(50),
    billingCycle: BillingCycleSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .openapi('CreateSubscriptionRequest')

export const CreateSubscriptionResponseSchema = z
  .object({
    attemptId: z.string().uuid(),
    razorpayKeyId: z.string(),
    razorpaySubscriptionId: z.string(),
    status: z.string(),
    region: BillingRegionSchema,
    planKey: z.string(),
    billingCycle: BillingCycleSchema,
    currency: BillingCurrencySchema,
    quote: BillingQuoteSchema,
  })
  .openapi('CreateSubscriptionResponse')

export const VerifySubscriptionSchema = z
  .object({
    attemptId: z.string().uuid(),
    razorpayPaymentId: z.string().trim().min(1).max(100),
    razorpaySubscriptionId: z.string().trim().min(1).max(100),
    razorpaySignature: z.string().trim().min(1).max(200),
  })
  .strict()
  .openapi('VerifySubscriptionRequest')

export const BillingStatusSchema = z
  .object({
    hasSubscription: z.boolean(),
    entitlement: z.enum(['active', 'grace', 'blocked']),
    accessAllowed: z.boolean(),
    graceUntil: z.string().datetime().nullable(),
    subscription: z
      .object({
        id: z.string().uuid(),
        providerSubscriptionId: z.string(),
        planKey: z.string(),
        billingCycle: BillingCycleSchema,
        currency: BillingCurrencySchema,
        status: z.string(),
        cancelAtCycleEnd: z.boolean(),
        currentEndAt: z.string().datetime().nullable(),
        lastPaymentId: z.string().nullable(),
        lastInvoiceId: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi('BillingStatus')

export const CancelSubscriptionSchema = z
  .object({ cancelAtCycleEnd: z.literal(true).default(true) })
  .strict()
  .openapi('CancelSubscriptionRequest')

export type BillingRegion = z.infer<typeof BillingRegionSchema>
export type BillingCycle = z.infer<typeof BillingCycleSchema>
export type BillingCurrency = z.infer<typeof BillingCurrencySchema>
export type CreateSubscriptionInput = z.infer<typeof CreateSubscriptionSchema>
