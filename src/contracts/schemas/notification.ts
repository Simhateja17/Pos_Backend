import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const NotificationSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['business_type_unset', 'po_received', 'staff_activated', 'stock_low']),
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    read: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('Notification')

export const NotificationListSchema = z
  .object({
    notifications: z.array(NotificationSchema),
    unreadCount: z.number().int(),
  })
  .openapi('NotificationList')

export type Notification = z.infer<typeof NotificationSchema>
