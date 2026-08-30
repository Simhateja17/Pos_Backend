import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { UnitOfMeasureSchema } from './product'

extendZodWithOpenApi(z)

export const MasterItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  category: z.string(),
  subcategory: z.string().nullable(),
  packSize: z.string().nullable(),
  packUnit: UnitOfMeasureSchema,
  sellUnit: UnitOfMeasureSchema,
  barcode: z.string().nullable(),
  displayName: z.string(),
}).openapi('MasterItem')

export const MasterItemSearchSchema = z.object({
  query: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
})

export const MasterItemListSchema = z.array(MasterItemSchema).openapi('MasterItemList')

export type MasterItem = z.infer<typeof MasterItemSchema>
