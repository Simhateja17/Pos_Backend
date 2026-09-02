import { z } from 'zod'

const email = z.string().trim().toLowerCase().email().max(320)
const requiredText = (max = 500) => z.string().trim().min(1).max(max)

export const AdminOtpRequestSchema = z.object({ email })
export const AdminOtpVerifySchema = z.object({ email, otp: z.string().trim().regex(/^\d{6}$/) })

export const AdminInviteSchema = z.object({
  email,
  displayName: requiredText(120),
  role: z.enum(['platform_owner', 'support_admin', 'read_only']),
})

export const AdminSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
})

export const AdminTenantIdSchema = z.object({ tenantId: z.string().uuid() })

export const AdminSupportRequestSchema = z.object({
  tenantId: z.string().uuid(),
  ticketId: requiredText(120),
  reason: requiredText(1_000),
})

export const MerchantSupportDecisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
})

export const AdminEntitlementOverrideSchema = z.object({
  tenantId: z.string().uuid(),
  entitlementKey: z.enum(['max_locations', 'max_active_users', 'max_active_registers', 'forecast_monthly_runs', 'catalog_products']),
  overrideValue: z.number().int().nonnegative().max(100_000),
  justification: requiredText(1_000),
  ticketId: requiredText(120),
  /** Overrides are bounded to 30 days; payment-provider state is untouched. */
  expiresAt: z.coerce.date(),
})

export const AdminRevokeOverrideSchema = z.object({ reason: requiredText(1_000) })

export const AdminPrivateOfferSchema = z.object({
  tenantId: z.string().uuid(),
  basePlanKey: z.enum(['starter', 'growth', 'pro']),
  billingCycle: z.enum(['monthly', 'annual']),
  negotiatedBaseAmountMinor: z.number().int().positive().max(100_000_000),
  includedLocations: z.number().int().positive().max(10_000),
  includedRegisters: z.number().int().positive().max(100_000),
  includedUsers: z.number().int().positive().max(100_000),
  additionalLocationUnitAmountMinor: z.number().int().nonnegative().max(100_000_000),
  additionalRegisterUnitAmountMinor: z.number().int().nonnegative().max(100_000_000),
  additionalUserUnitAmountMinor: z.number().int().nonnegative().max(100_000_000),
  trialDurationMinutes: z.number().int().min(0).max(525_600),
  latestActivationAt: z.coerce.date(),
  priceValidity: z.enum(['until_changed', 'fixed_cycles']),
  fixedBillingCycles: z.number().int().positive().max(1_200).nullable(),
  internalReason: requiredText(1_000),
  salesReference: z.string().trim().max(120).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.priceValidity === 'fixed_cycles') !== (value.fixedBillingCycles !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['fixedBillingCycles'], message: 'Billing cycles must match price validity' })
  }
})

export const AdminRetrySchema = z.object({
  operationKind: z.enum(['webhook', 'email', 'import', 'forecast']),
  operationId: requiredText(200),
  idempotencyKey: z.string().trim().min(8).max(200),
})

export const AdminMfaResetSchema = z.object({
  targetEmail: email,
  reason: requiredText(1_000),
})

export const AdminListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().min(0).max(100_000).default(0),
})

export const AdminAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  action: z.string().trim().min(1).max(120).optional(),
  tenantId: z.string().uuid().optional(),
})

const optionalUrl = z.union([z.string().trim().url().max(2_000).refine((value) => /^https?:\/\//i.test(value), 'Use an HTTP or HTTPS image URL'), z.literal('')]).transform((value) => value || null)

export const AdminBlogPostSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  title: requiredText(160),
  excerpt: requiredText(320),
  body: requiredText(50_000),
  category: requiredText(80),
  authorName: requiredText(120).default('Ambel POS Editorial'),
  coverImageUrl: optionalUrl.default(''),
  seoTitle: z.string().trim().max(70).optional().transform((value) => value || null),
  seoDescription: z.string().trim().max(170).optional().transform((value) => value || null),
  status: z.enum(['draft', 'published']).default('draft'),
})

export const AdminBlogIdSchema = z.object({ postId: z.string().uuid() })
