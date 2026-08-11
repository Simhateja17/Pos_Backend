import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

const TransferLineInputSchema = z.object({
  variantId: z.string().uuid(),
  quantitySent: z.number().positive(),
})

export const CreateStockTransferSchema = z
  .object({
    clientTransferId: z.string().uuid(),
    toStoreId: z.string().uuid(),
    note: z.string().trim().max(500).optional(),
    lines: z.array(TransferLineInputSchema).min(1).max(500),
  })
  .strict()
  .openapi('CreateStockTransferRequest')

export const ReceiveStockTransferSchema = z
  .object({
    clientReceiveId: z.string().uuid(),
    lines: z
      .array(z.object({ transferLineId: z.string().uuid(), quantityReceived: z.number().nonnegative() }))
      .min(1)
      .max(500),
  })
  .strict()
  .openapi('ReceiveStockTransferRequest')

export const StockTransferSchema = z
  .object({
    id: z.string().uuid(),
    clientTransferId: z.string().uuid(),
    clientReceiveId: z.string().uuid().nullable(),
    fromStoreId: z.string().uuid(),
    fromStoreName: z.string(),
    toStoreId: z.string().uuid(),
    toStoreName: z.string(),
    status: z.enum(['sent', 'received', 'cancelled']),
    note: z.string().nullable(),
    sentAt: z.string(),
    receivedAt: z.string().nullable(),
    lines: z.array(
      z.object({
        id: z.string().uuid(),
        variantId: z.string().uuid(),
        sku: z.string(),
        quantitySent: z.string(),
        quantityReceived: z.string().nullable(),
        discrepancy: z.string().nullable(),
      }),
    ),
  })
  .openapi('StockTransfer')

export const StockTransferListSchema = z.array(StockTransferSchema).openapi('StockTransferList')
export const TransferDestinationListSchema = z
  .array(z.object({ id: z.string().uuid(), name: z.string() }))
  .openapi('TransferDestinationList')

export type CreateStockTransferInput = z.infer<typeof CreateStockTransferSchema>
export type ReceiveStockTransferInput = z.infer<typeof ReceiveStockTransferSchema>
