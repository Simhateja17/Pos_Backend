import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { TerminalSchema } from './terminal'

extendZodWithOpenApi(z)

export const OpenShiftSchema = z
  .object({
    startingCash: z.string().regex(/^\d+\.\d{2}$/).optional(),
    /** Which counter this drawer belongs to (0034). */
    terminalId: z.string().uuid().optional(),
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
    /** Nullable only for pre-0034 rows the backfill could not attribute. */
    terminalId: z.string().uuid().nullable(),
    startingCash: z.string(),
    openedAt: z.string(),
    countedCash: z.string().nullable(),
    variance: z.string().nullable(),
    closedAt: z.string().nullable(),
  })
  .openapi('Shift')

/**
 * A shift as it appears in history — the same row plus the human names the
 * list needs, resolved server-side so the client never has to join staff and
 * terminal lists itself.
 */
export const ShiftHistoryEntrySchema = ShiftSchema.extend({
  staffName: z.string().nullable(),
  terminalName: z.string().nullable(),
}).openapi('ShiftHistoryEntry')

export const CurrentShiftSchema = z
  .object({
    terminal: z.union([TerminalSchema, z.null()]),
    shift: z.union([ShiftSchema.extend({ staffName: z.string().nullable() }), z.null()]),
  })
  .openapi('CurrentShift')

export const XReportSchema = z
  .object({
    shiftId: z.string().uuid(),
    expectedCash: z.string(),
    cashSalesTotal: z.string(),
    cardSalesTotal: z.string(),
    upiSalesTotal: z.string(),
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
export type ShiftHistoryEntry = z.infer<typeof ShiftHistoryEntrySchema>
export type XReport = z.infer<typeof XReportSchema>
export type ZReport = z.infer<typeof ZReportSchema>
