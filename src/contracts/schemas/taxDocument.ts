import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const TaxDocumentTypeSchema = z.enum(['tax_invoice', 'credit_note']).openapi('TaxDocumentType')

export const TaxPartySnapshotSchema = z
  .object({
    legalName: z.string().nullable(),
    tradeName: z.string().nullable(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    stateCode: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  })
  .openapi('TaxPartySnapshot')

export const PlaceOfSupplySnapshotSchema = z
  .object({
    state: z.string().nullable(),
    stateCode: z.string().nullable(),
    isInterState: z.boolean(),
  })
  .openapi('PlaceOfSupplySnapshot')

export const TaxPaymentSnapshotSchema = z
  .object({
    method: z.string(),
    direction: z.enum(['payment', 'refund']),
    amount: z.string(),
    referenceCode: z.string().nullable(),
  })
  .openapi('TaxPaymentSnapshot')

export const TaxDocumentLineSchema = z
  .object({
    saleLineItemId: z.string().uuid().nullable(),
    originalLineId: z.string().uuid().nullable(),
    variantId: z.string().uuid().nullable(),
    description: z.string(),
    sku: z.string().nullable(),
    hsnSac: z.string().nullable(),
    unit: z.string(),
    quantity: z.string(),
    unitPrice: z.string(),
    grossValue: z.string(),
    discountValue: z.string(),
    taxableValue: z.string(),
    gstRate: z.string(),
    cgstAmount: z.string(),
    sgstAmount: z.string(),
    igstAmount: z.string(),
    cessAmount: z.string(),
    lineTotal: z.string(),
  })
  .openapi('TaxDocumentLine')

export const TaxDocumentSchema = z
  .object({
    id: z.string().uuid(),
    documentType: TaxDocumentTypeSchema,
    financialYear: z.string(),
    sequenceNumber: z.string(),
    documentNumber: z.string(),
    documentDate: z.string().datetime({ offset: true }),
    tenantId: z.string().uuid(),
    storeId: z.string().uuid(),
    saleId: z.string().uuid(),
    customerId: z.string().uuid().nullable(),
    returnReferenceId: z.string().uuid().nullable(),
    originalDocumentId: z.string().uuid().nullable(),
    originalDocumentNumber: z.string().nullable(),
    seller: TaxPartySnapshotSchema,
    // A union keeps the generated OpenAPI type as `TaxPartySnapshot | null`.
    // `.nullable()` on a referenced OpenAPI component is emitted as an
    // `allOf` intersection by zod-to-openapi, which becomes an unusable
    // `Record<string, never>` in openapi-typescript.
    buyer: z.union([TaxPartySnapshotSchema, z.null()]),
    placeOfSupply: PlaceOfSupplySnapshotSchema,
    payments: z.array(TaxPaymentSnapshotSchema),
    subtotal: z.string(),
    discountTotal: z.string(),
    taxableTotal: z.string(),
    cgstTotal: z.string(),
    sgstTotal: z.string(),
    igstTotal: z.string(),
    cessTotal: z.string(),
    roundingAmount: z.string(),
    grandTotal: z.string(),
    lines: z.array(TaxDocumentLineSchema),
    createdAt: z.string().datetime({ offset: true }),
  })
  .openapi('TaxDocument')

export const TaxDocumentSummarySchema = TaxDocumentSchema.omit({ lines: true }).openapi('TaxDocumentSummary')

export const TaxDocumentListQuerySchema = z
  .object({
    documentType: TaxDocumentTypeSchema.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    customerId: z.string().uuid().optional(),
    documentNumber: z.string().trim().max(16).optional(),
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to), {
    message: 'from must be before to',
    path: ['from'],
  })
  .openapi('TaxDocumentListQuery')

export const CreateTaxInvoiceSchema = z
  .object({ saleId: z.string().uuid() })
  .openapi('CreateTaxInvoiceRequest')

export const TaxDocumentListSchema = z
  .object({
    items: z.array(TaxDocumentSummarySchema),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
  })
  .openapi('TaxDocumentList')

export type TaxDocument = z.infer<typeof TaxDocumentSchema>
export type TaxDocumentListQuery = z.infer<typeof TaxDocumentListQuerySchema>
