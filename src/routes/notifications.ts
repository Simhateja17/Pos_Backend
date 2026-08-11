import { Router } from 'express'
import { forTenantTransaction } from '../db/tenantClient'
import { effectiveRole } from '../middleware/requireRole'
import { storeScopeWhere } from '../middleware/storeContext'

const router = Router()

function toNotificationJson(row: any, storeNames: Map<string, string>) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
    // null store_id means the notification is about the BUSINESS, not one
    // shop — a failed subscription payment belongs to the company, a low-stock
    // alert belongs to a shelf (migration 0043).
    storeId: row.store_id,
    storeName: row.store_id ? storeNames.get(row.store_id) ?? null : null,
  }
}

/**
 * GET / — notifications for whoever is asking (Phase 8, task 11).
 *
 * A MANAGER SEES THEIR OWN SHOP, plus business-wide items. Alerts about a shop
 * they cannot act on are noise: telling the Andheri manager that Bandra is low
 * on a shirt invites them to do nothing about it, and teaches them to ignore
 * the panel.
 *
 * AN OWNER SEES EVERYTHING, but grouped. `byStore` carries an unread count per
 * shop so the UI can lead with "Andheri 12, Bandra 3" instead of fifteen
 * separate rows. That grouping is the whole point: an owner with several shops
 * gets one alert per low variant per shop, and a panel that lists them
 * individually is muted within a week — at which point the feature is dead and
 * nobody notices it died.
 *
 * The route deliberately does NOT filter by type. Grouping is what makes the
 * volume manageable; hiding categories would make it incomplete.
 */
router.get('/', async (req, res) => {
  const isOwner = effectiveRole(req) === 'owner'
  // Owners historically receive the full digest when no store is selected.
  // Once they explicitly select a shop, the same endpoint must respect that
  // request scope; a manager PIN-switched onto an owner JWT is always scoped.
  const header = req.headers['x-store-id']
  const hasExplicitStoreScope = Boolean((Array.isArray(header) ? header[0] : header)?.trim())
  const storeScope = isOwner && !hasExplicitStoreScope ? {} : storeScopeWhere(req)
  const visibleWhere = storeScope.store_id
    ? { OR: [{ store_id: storeScope.store_id }, { store_id: null }] }
    : {}

  const { rows, stores, tenant } = await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const rows = await tx.notifications.findMany({
      // Own shop OR business-wide. A manager should still learn that the
      // subscription failed; they just should not field another shop's stock
      // alerts. An explicitly selected owner shop follows the same rule.
      where: visibleWhere,
      orderBy: { created_at: 'desc' },
    })
    const stores = await tx.stores.findMany({ select: { id: true, name: true } })
    const tenant = await tx.tenants.findFirst({ select: { timezone: true } })
    return { rows, stores, tenant }
  })

  const storeNames = new Map<string, string>(
    stores.map((store: any) => [store.id, store.name] as [string, string]),
  )

  const unread = rows.filter((row: any) => row.read_at === null)

  // Only meaningful when the caller can see more than one shop. Sending it to
  // a manager would imply a breakdown they are not scoped to act on.
  const byStore = isOwner
    ? stores
        .map((store: any) => ({
          storeId: store.id,
          storeName: store.name,
          unreadCount: unread.filter((row: any) => row.store_id === store.id).length,
        }))
        .filter((entry: any) => entry.unreadCount > 0)
        .sort((a: any, b: any) => b.unreadCount - a.unreadCount)
    : []

  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tenant?.timezone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const digestMap = new Map<string, any>()
  if (isOwner) {
    for (const row of rows.filter((item: any) => item.store_id !== null)) {
      const date = dateFormatter.format(row.created_at)
      const key = `${date}:${row.store_id}`
      const current = digestMap.get(key) ?? {
        date,
        storeId: row.store_id,
        storeName: storeNames.get(row.store_id) ?? 'Store',
        totalCount: 0,
        unreadCount: 0,
        sampleTitles: [],
      }
      current.totalCount += 1
      if (row.read_at === null) current.unreadCount += 1
      if (current.sampleTitles.length < 3) current.sampleTitles.push(row.title)
      digestMap.set(key, current)
    }
  }
  const dailyDigest = [...digestMap.values()].sort((a, b) => b.date.localeCompare(a.date))

  return res.json({
    // Owners get shop-specific alerts through dailyDigest, not one noisy row
    // per item. Business-wide items remain individual because they are rare
    // and may require immediate action. Managers retain their own-shop feed.
    notifications: rows
      .filter((row: any) => !isOwner || row.store_id === null)
      .map((row: any) => toNotificationJson(row, storeNames)),
    unreadCount: unread.length,
    byStore,
    dailyDigest,
    businessWideUnreadCount: unread.filter((row: any) => row.store_id === null).length,
  })
})

/**
 * POST /read — marks read exactly what the caller can see, and nothing more.
 *
 * Scoped for the same reason the read is: a manager clearing their panel must
 * not silently clear another shop's unread alerts, which would hide a stockout
 * from the person responsible for it.
 */
router.post('/read', async (req, res) => {
  const isOwner = effectiveRole(req) === 'owner'
  const header = req.headers['x-store-id']
  const hasExplicitStoreScope = Boolean((Array.isArray(header) ? header[0] : header)?.trim())
  const storeScope = isOwner && !hasExplicitStoreScope ? {} : storeScopeWhere(req)
  const visibleWhere = storeScope.store_id
    ? { OR: [{ store_id: storeScope.store_id }, { store_id: null }] }
    : {}

  await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    await tx.notifications.updateMany({
      where: {
        read_at: null,
        ...visibleWhere,
      },
      data: { read_at: new Date() },
    })
  })

  return res.status(200).json({ ok: true })
})

export default router
