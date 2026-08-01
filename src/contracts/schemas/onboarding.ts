import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional()
const requiredText = (max: number) => z.string().trim().min(1).max(max)
const optionalPhone = z.string().trim().min(7).max(24).optional()

/**
 * Step 1 is now plan selection only.
 *
 * Business identity and GST/tax registration moved to signup, which already
 * captured the business name and address — re-asking them here produced two
 * unreconciled records of the same business. The vertical picker
 * (`storeCategory`) is gone entirely: the product is general retail, and the
 * field drove nothing beyond echoing itself back on the completion screen.
 *
 * The tier chosen here is not enforced and does not gate access — no billing
 * gateway is integrated yet. It records intent for the trial only.
 */
export const PlanSelectionStepSchema = z
  .object({
    trialPlan: z.enum(['starter', 'growth', 'enterprise']),
    billingCycle: z.enum(['monthly', 'annual']),
  })
  .strict()
  .openapi('OnboardingPlanSelectionStep')

export const StoreSetupStepSchema = z
  .object({
    storeName: requiredText(200),
    addressLine1: requiredText(250),
    addressLine2: optionalText(250),
    postalCode: requiredText(12),
    city: requiredText(100),
    state: requiredText(100),
    storeType: z.enum(['mall_kiosk', 'mall_shop', 'high_street', 'standalone', 'airport', 'outlet']),
    storeClassification: z.enum(['flagship', 'branch', 'franchise', 'popup']),
    carpetAreaSqFt: z.number().int().positive().max(1_000_000).optional(),
    storeCode: optionalText(30),
    openingTime: z.string().regex(/^\d{2}:\d{2}$/),
    managerName: optionalText(200),
    managerPhone: optionalPhone,
  })
  .strict()
  .openapi('OnboardingStoreSetupStep')

export const BillingInvoiceStepSchema = z
  .object({
    invoicePrefix: requiredText(20),
    invoiceStartNumber: z.number().int().positive(),
    paymentTermsDays: z.enum(['0', '7', '15', '30', '45', '60']),
    gstPricingMode: z.enum(['exclusive', 'inclusive']),
    defaultGstSlab: z.enum(['0', '5', '12', '18', '28']),
    rounding: z.enum(['nearest1', 'nearest50p', 'none']),
    financialYearStart: z.enum(['april', 'jan']),
    printHsn: z.boolean(),
    printDuplicateCopy: z.boolean(),
    invoiceQrEnabled: z.boolean(),
    invoiceFooter: optionalText(500),
  })
  .strict()
  .openapi('OnboardingBillingInvoiceStep')

export const PaymentMethodsStepSchema = z
  .object({
    cashEnabled: z.boolean(),
    maxCashPerTransaction: z.number().nonnegative().max(200_000).optional(),
    upiEnabled: z.boolean(),
    upiPartner: z
      .enum(['razorpay', 'phonepe', 'bharatpe', 'paytm', 'pinelabs_upi', 'googlepay'])
      .optional(),
    soundBoxEnabled: z.boolean(),
    cardEnabled: z.boolean(),
    cardProvider: z.enum(['pinelabs', 'mosambee', 'mswipe', 'hdfc', 'payu', 'plural']).optional(),
    contactlessEnabled: z.boolean(),
    emiEnabled: z.boolean(),
    giftCardEnabled: z.boolean(),
    storeCreditEnabled: z.boolean(),
    maxStoreCredit: z.number().nonnegative().optional(),
    splitPaymentEnabled: z.boolean(),
    advancePaymentEnabled: z.boolean(),
  })
  .strict()
  .refine((value) => value.cashEnabled || value.upiEnabled || value.cardEnabled, {
    message: 'At least one core payment method must be enabled',
  })
  .openapi('OnboardingPaymentMethodsStep')

export const ProductCatalogStepSchema = z
  .object({
    skuCount: z.enum(['under100', '100-500', '500-2000', '2000-10000', '10000plus']),
    importMethod: z.enum(['csv', 'barcode', 'tally', 'manual']),
    unitOfMeasure: z.enum(['piece', 'kg', 'gram', 'litre', 'ml', 'metre', 'box', 'pack', 'set', 'pair']),
    barcodeFormat: z.enum(['ean13', 'code128', 'qr', 'upca', 'internal']),
    hsnAutoLookup: z.boolean(),
    mrpRequired: z.boolean(),
    variantTracking: z.boolean(),
    batchTracking: z.boolean(),
    expiryTracking: z.boolean(),
    serialTracking: z.boolean(),
    serviceItemsEnabled: z.boolean(),
    negativeStockPolicy: z.enum(['block', 'warn', 'allow']),
  })
  .strict()
  .openapi('OnboardingProductCatalogStep')

export const HardwareDevicesStepSchema = z
  .object({
    billingCounters: z.enum(['1', '2', '3', '4', '5', '5plus']),
    printerConnection: z.enum(['cloud', 'lan', 'bluetooth', 'none']),
    paperWidthMm: z.enum(['58', '80']).optional(),
    scannerConnection: z.enum(['usb', 'bluetooth', 'rf', 'none']),
    cashDrawerMode: z.enum(['auto', 'manual', 'none']),
    cardTerminalType: z.enum(['pinelabs', 'mosambee', 'order', 'none']),
    customerDisplayEnabled: z.boolean(),
    weighingScaleEnabled: z.boolean(),
    labelPrinterEnabled: z.boolean(),
    kitchenDisplayEnabled: z.boolean(),
  })
  .strict()
  .openapi('OnboardingHardwareDevicesStep')

const FirstStaffSchema = z
  .object({
    name: requiredText(200),
    phone: optionalPhone,
    email: z.string().email().max(200).optional(),
    accessLevel: z.enum(['cashier', 'senior_cashier', 'floor_staff', 'manager']),
    defaultShift: z.enum(['morning', 'mid', 'evening', 'full']),
  })
  .strict()

export const TeamAccessStepSchema = z
  .object({
    approvalRules: z
      .object({
        discountEnabled: z.boolean(),
        discountThresholdPercent: z.number().min(0).max(100),
        refundEnabled: z.boolean(),
        voidEnabled: z.boolean(),
        settingsEnabled: z.boolean(),
      })
      .strict(),
    firstStaff: FirstStaffSchema.optional(),
    openingFloatPerCounter: z.number().nonnegative(),
    endOfDayReminder: z.string().regex(/^\d{2}:\d{2}$/),
    autoClockOutHours: z.enum(['8', '10', '12']),
  })
  .strict()
  .openapi('OnboardingTeamAccessStep')

/**
 * Step 2 is deliberately absent. It held GST & legal compliance, now captured
 * at signup. The remaining numbers are left unchanged rather than renumbered so
 * that onboarding_data already persisted for a tenant keeps its meaning.
 */
export const OnboardingStepSchemas = {
  1: PlanSelectionStepSchema,
  3: StoreSetupStepSchema,
  4: BillingInvoiceStepSchema,
  5: PaymentMethodsStepSchema,
  6: ProductCatalogStepSchema,
  7: HardwareDevicesStepSchema,
  8: TeamAccessStepSchema,
} as const

/**
 * ONBOARD-01 — nothing but plan selection stands between signup and a working
 * till. Steps 3-8 are no longer a wizard at all: each field is asked in-context
 * by the screen that actually needs it, indexed from the dashboard's setup
 * prompt. They remain valid save targets so those prompts have somewhere to
 * write.
 */
export const REQUIRED_ONBOARDING_STEPS = [1] as const
export const DEFERRED_ONBOARDING_STEPS = [3, 4, 5, 6, 7, 8] as const

export function isRequiredOnboardingStep(step: number): boolean {
  return (REQUIRED_ONBOARDING_STEPS as readonly number[]).includes(step)
}

export const ONBOARDING_STEP_NUMBERS = [1, 3, 4, 5, 6, 7, 8] as const

export const OnboardingStepNumberSchema = z.coerce
  .number()
  .int()
  .refine((step): step is (typeof ONBOARDING_STEP_NUMBERS)[number] =>
    (ONBOARDING_STEP_NUMBERS as readonly number[]).includes(step),
  )
  .openapi('OnboardingStepNumber')

export const OnboardingStepInputSchema = z
  .union([
    PlanSelectionStepSchema,
    StoreSetupStepSchema,
    BillingInvoiceStepSchema,
    PaymentMethodsStepSchema,
    ProductCatalogStepSchema,
    HardwareDevicesStepSchema,
    TeamAccessStepSchema,
  ])
  .openapi('OnboardingStepRequest')

export const OnboardingDataSchema = z
  .object({
    '1': PlanSelectionStepSchema.optional(),
    '3': StoreSetupStepSchema.optional(),
    '4': BillingInvoiceStepSchema.optional(),
    '5': PaymentMethodsStepSchema.optional(),
    '6': ProductCatalogStepSchema.optional(),
    '7': HardwareDevicesStepSchema.optional(),
    '8': TeamAccessStepSchema.optional(),
  })
  .strict()
  .openapi('OnboardingData')

export const OnboardingStateSchema = z
  .object({
    data: OnboardingDataSchema,
    currentStep: z.number().int().min(0).max(8),
    completed: z.boolean(),
    completedAt: z.string().datetime().nullable(),
    requiredSteps: z.array(z.number().int().min(1).max(8)),
    requiredStepsComplete: z.boolean(),
    /** Deferred steps not yet saved — drives the in-app "finish setup" prompts. */
    pendingSteps: z.array(z.number().int().min(1).max(8)),
  })
  .openapi('OnboardingState')

export const CompleteOnboardingSchema = z.object({}).strict().openapi('CompleteOnboardingRequest')

export const OnboardingCompletionResponseSchema = OnboardingStateSchema.extend({
  summary: z.object({
    businessName: z.string(),
    /** Null until the deferred store-setup step is finished. */
    storeName: z.string().nullable(),
    trialPlan: z.string(),
    /** Null until the deferred hardware step is finished. */
    billingCounters: z.string().nullable(),
    /** Null when the owner has not told us their GST status — not required to trade. */
    gstStatus: z.string().nullable(),
  }),
}).openapi('OnboardingCompletionResponse')

export type OnboardingData = z.infer<typeof OnboardingDataSchema>
export type OnboardingState = z.infer<typeof OnboardingStateSchema>
export type OnboardingStepNumber = keyof typeof OnboardingStepSchemas
