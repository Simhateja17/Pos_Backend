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
    /**
     * Which shop this concerns, or null for a business-wide notification
     * (migration 0043). A failed subscription payment belongs to the company;
     * a low-stock alert belongs to a shelf.
     */
    storeId: z.string().uuid().nullable(),
    storeName: z.string().nullable(),
  })
  .openapi('Notification')

export const StoreUnreadCountSchema = z
  .object({
    storeId: z.string().uuid(),
    storeName: z.string(),
    unreadCount: z.number().int(),
  })
  .openapi('StoreUnreadCount')

export const NotificationDigestSchema = z
  .object({
    date: z.string(),
    storeId: z.string().uuid(),
    storeName: z.string(),
    totalCount: z.number().int(),
    unreadCount: z.number().int(),
    sampleTitles: z.array(z.string()),
  })
  .openapi('NotificationDigest')

export const NotificationListSchema = z
  .object({
    notifications: z.array(NotificationSchema),
    unreadCount: z.number().int(),
    /**
     * Unread counts per shop, OWNER ONLY and empty for anyone else. Lets the
     * UI lead with "Andheri 12, Bandra 3" rather than listing fifteen rows —
     * an owner with several shops gets one alert per low variant per shop, and
     * an ungrouped panel is muted within a week.
     */
    byStore: z.array(StoreUnreadCountSchema),
    /** Owner-only daily shop alert bundles; empty for managers. */
    dailyDigest: z.array(NotificationDigestSchema),
    /** Unread notifications about the business rather than any one shop. */
    businessWideUnreadCount: z.number().int(),
  })
  .openapi('NotificationList')

export type Notification = z.infer<typeof NotificationSchema>
export type StoreUnreadCount = z.infer<typeof StoreUnreadCountSchema>
