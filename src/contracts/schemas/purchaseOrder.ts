import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const PurchaseOrderStatusSchema = z
  .enum(['draft', 'sent', 'partial', 'received', 'cancelled'])
  .openapi('PurchaseOrderStatus')

export const PurchaseOrderLineSchema = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid(),
    sku: z.string(),
    productName: z.string(),
    quantityOrdered: z.number(),
    quantityReceived: z.number(),
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
  })
  .openapi('PurchaseOrder')

export const CreatePurchaseOrderSchema = z
  .object({
    supplierId: z.string().uuid(),
    expectedDate: z.string().date().optional(),
    notes: z.string().max(1000).optional(),
    lines: z
      .array(
        z.object({
          variantId: z.string().uuid(),
          quantityOrdered: z.number().positive(),
          unitCost: z.number().nonnegative(),
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
          quantityReceived: z.number().positive(),
          // Optional: falls back to the line's ordered unit cost when the
          // delivery charged the price the PO expected.
          unitCost: z.number().nonnegative().optional(),
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
        quantityOrdered: z.number(),
        quantityReceived: z.number(),
      }),
    ),
    purchaseOrder: PurchaseOrderSchema,
  })
  .openapi('ReceiptResult')

export const PurchaseOrderListSchema = z.array(PurchaseOrderSchema).openapi('PurchaseOrderList')

export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>
export type ReceivePurchaseOrderInput = z.infer<typeof ReceivePurchaseOrderSchema>
