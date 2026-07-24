import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional()
const requiredText = (max: number) => z.string().trim().min(1).max(max)
const optionalPhone = z.string().trim().min(7).max(24).optional()

export const BusinessIdentityStepSchema = z
  .object({
    storeCategory: z.enum([
      'fashion',
      'beauty',
      'electronics',
      'footwear',
      'jewellery',
      'books',
      'pharmacy',
      'grocery',
      'multi',
    ]),
    trialPlan: z.enum(['starter', 'growth', 'enterprise']),
    billingCycle: z.enum(['monthly', 'annual']),
    legalName: requiredText(200),
    tradeName: optionalText(200),
    businessStructure: z.enum([
      'pvtltd',
      'llp',
      'partnership',
      'proprietorship',
      'public',
      'huf',
      'trust',
    ]),
    yearEstablished: z.number().int().min(1800).max(new Date().getUTCFullYear()),
    registrationNumber: optionalText(32),
    natureOfBusiness: z.enum(['retailer', 'wholesaler', 'both', 'mfr_retail', 'service']),
    storeCount: z.enum(['1', '2', '3', '4', '5', '6-10', '11-20', '20+']),
  })
  .strict()
  .openapi('OnboardingBusinessIdentityStep')

export const GstComplianceStepSchema = z
  .object({
    gstStatus: z.enum(['regular', 'composition', 'unregistered']),
    gstin: optionalText(15),
    pan: optionalText(10),
    placeOfSupply: requiredText(100),
    fssai: optionalText(30),
    drugLicense: optionalText(50),
    msmeRegistration: optionalText(50),
    shopEstablishmentLicense: optionalText(50),
    eInvoiceEnabled: z.boolean(),
    eWayBillEnabled: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.gstStatus !== 'unregistered' && !value.gstin) {
      ctx.addIssue({
        code: 'custom',
        message: 'GSTIN is required for registered businesses',
        path: ['gstin'],
      })
    }
    if (value.gstStatus !== 'unregistered' && !value.pan) {
      ctx.addIssue({
        code: 'custom',
        message: 'PAN is required for registered businesses',
        path: ['pan'],
      })
    }
  })
  .openapi('OnboardingGstComplianceStep')

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

export const OnboardingStepSchemas = {
  1: BusinessIdentityStepSchema,
  2: GstComplianceStepSchema,
  3: StoreSetupStepSchema,
  4: BillingInvoiceStepSchema,
  5: PaymentMethodsStepSchema,
  6: ProductCatalogStepSchema,
  7: HardwareDevicesStepSchema,
  8: TeamAccessStepSchema,
} as const

export const OnboardingStepNumberSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(8)
  .openapi('OnboardingStepNumber')

export const OnboardingStepInputSchema = z
  .union([
    BusinessIdentityStepSchema,
    GstComplianceStepSchema,
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
    '1': BusinessIdentityStepSchema.optional(),
    '2': GstComplianceStepSchema.optional(),
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
  })
  .openapi('OnboardingState')

export const CompleteOnboardingSchema = z.object({}).strict().openapi('CompleteOnboardingRequest')

export const OnboardingCompletionResponseSchema = OnboardingStateSchema.extend({
  summary: z.object({
    businessName: z.string(),
    storeName: z.string(),
    storeCategory: z.string(),
    trialPlan: z.string(),
    billingCounters: z.string(),
    gstStatus: z.string(),
  }),
}).openapi('OnboardingCompletionResponse')

export type OnboardingData = z.infer<typeof OnboardingDataSchema>
export type OnboardingState = z.infer<typeof OnboardingStateSchema>
export type OnboardingStepNumber = keyof typeof OnboardingStepSchemas
