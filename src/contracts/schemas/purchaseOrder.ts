import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

const QuantityDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,3})?$/)
const PositiveQuantityDecimalSchema = QuantityDecimalSchema.refine((value) => Number(value) > 0, 'Must be positive')
const MoneyDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/)

export const PurchaseOrderStatusSchema = z
  .enum(['draft', 'sent', 'partial', 'received', 'cancelled'])
  .openapi('PurchaseOrderStatus')

export const PurchaseOrderLineSchema = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid(),
    sku: z.string(),
    productName: z.string(),
    quantityOrdered: QuantityDecimalSchema,
    quantityReceived: QuantityDecimalSchema,
    unitCost: z.string(),
    lineTotal: z.string(),
  })
  .openapi('PurchaseOrderLine')

export const PurchaseOrderSchema = z
  .object({
    id: z.string().uuid(),
    poNumber: z.string(),
    supplierId: z.string().uuid(),
    supplierName: z.string(),
    status: PurchaseOrderStatusSchema,
    expectedDate: z.string().nullable(),
    notes: z.string().nullable(),
    totalCost: z.string(),
    lines: z.array(PurchaseOrderLineSchema),
    createdAt: z.string(),
    clientPurchaseOrderId: z.string().uuid().nullable().optional(),
    replayed: z.boolean().optional(),
  })
  .openapi('PurchaseOrder')

export const CreatePurchaseOrderSchema = z
  .object({
    // Optional only for temporary deployed-web compatibility. New clients,
    // including mobile, must always send this stable retry key.
    clientPurchaseOrderId: z.string().uuid().optional(),
    supplierId: z.string().uuid(),
    expectedDate: z.string().date().optional(),
    notes: z.string().max(1000).optional(),
    lines: z
      .array(
        z.object({
          variantId: z.string().uuid(),
          quantityOrdered: PositiveQuantityDecimalSchema,
          unitCost: MoneyDecimalSchema,
        }),
      )
      .min(1),
  })
  .openapi('CreatePurchaseOrderRequest')

export const UpdatePurchaseOrderSchema = z
  .object({
    // Only status transitions the owner drives directly. draft -> sent marks
    // the order placed (and is what makes it count toward on_order);
    // partial/received are DERIVED by the receipt trigger and are rejected here.
    status: z.enum(['sent', 'cancelled']).optional(),
    expectedDate: z.string().date().optional(),
    notes: z.string().max(1000).optional(),
  })
  .openapi('UpdatePurchaseOrderRequest')

/**
 * Goods receipt. `clientReceiptId` is client-supplied and is the idempotency
 * key — the (tenant_id, client_receipt_id) unique index is the actual
 * guarantee that a retried receipt does not double stock.
 */
export const ReceivePurchaseOrderSchema = z
  .object({
    clientReceiptId: z.string().uuid(),
    note: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          purchaseOrderLineId: z.string().uuid(),
          quantityReceived: PositiveQuantityDecimalSchema,
          // Optional: falls back to the line's ordered unit cost when the
          // delivery charged the price the PO expected.
          unitCost: MoneyDecimalSchema.optional(),
        }),
      )
      .min(1),
  })
  .openapi('ReceivePurchaseOrderRequest')

export const ReceiptResultSchema = z
  .object({
    receiptId: z.string().uuid(),
    /** True when this exact clientReceiptId had already been recorded. */
    replayed: z.boolean(),
    /** Lines where received-to-date now exceeds ordered — allowed, but surfaced. */
    overReceived: z.array(
      z.object({
        purchaseOrderLineId: z.string().uuid(),
        sku: z.string(),
        quantityOrdered: QuantityDecimalSchema,
        quantityReceived: QuantityDecimalSchema,
      }),
    ),
    purchaseOrder: PurchaseOrderSchema,
  })
  .openapi('ReceiptResult')

export const PurchaseOrderListSchema = z.array(PurchaseOrderSchema).openapi('PurchaseOrderList')

export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>
export type ReceivePurchaseOrderInput = z.infer<typeof ReceivePurchaseOrderSchema>
