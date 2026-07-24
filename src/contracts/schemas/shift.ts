import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const OpenShiftSchema = z
  .object({
    startingCash: z.string().regex(/^\d+\.\d{2}$/),
  })
  .openapi('OpenShiftRequest')

export const CloseShiftSchema = z
  .object({
    countedCash: z.string().regex(/^\d+\.\d{2}$/),
  })
  .openapi('CloseShiftRequest')

export const ShiftSchema = z
  .object({
    id: z.string().uuid(),
    staffId: z.string().uuid(),
    startingCash: z.string(),
    openedAt: z.string(),
    countedCash: z.string().nullable(),
    variance: z.string().nullable(),
    closedAt: z.string().nullable(),
  })
  .openapi('Shift')

export const XReportSchema = z
  .object({
    shiftId: z.string().uuid(),
    expectedCash: z.string(),
    cashSalesTotal: z.string(),
    cardSalesTotal: z.string(),
    checkSalesTotal: z.string(),
    refundsTotal: z.string(),
    saleCount: z.number().int(),
  })
  .openapi('XReport')

export const ZReportSchema = XReportSchema.extend({
  countedCash: z.string(),
  variance: z.string(),
  closedAt: z.string(),
}).openapi('ZReport')

export type OpenShiftInput = z.infer<typeof OpenShiftSchema>
export type CloseShiftInput = z.infer<typeof CloseShiftSchema>
export type Shift = z.infer<typeof ShiftSchema>
export type XReport = z.infer<typeof XReportSchema>
export type ZReport = z.infer<typeof ZReportSchema>
