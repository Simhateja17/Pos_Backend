import type { NextFunction, Request, Response } from 'express'
import { forTenant } from '../db/tenantClient'

const STORE_HEADER = 'x-store-id'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requestedStoreId(req: Request): string | undefined {
  const header = req.headers[STORE_HEADER]
  const value = Array.isArray(header) ? header[0] : header
  return value?.trim() || undefined
}

function effectiveRole(req: Request): 'owner' | 'manager' | 'cashier' | undefined {
  return req.actingStaff?.role ?? req.user?.role
}

async function effectiveMembershipStoreId(req: Request): Promise<string | null> {
  if (!req.user) return null
  if (!req.actingStaff) return req.user.storeId
  if (req.actingStaff.storeId) return req.actingStaff.storeId

  // Tokens minted before Phase 8 did not carry store_id. Resolve those legacy
  // operator claims from the tenant-scoped staff row before accepting a store
  // header, so the fallback can never become an authorization decision.
  const client = forTenant(req.user.tenantId) as any
  const staff = await client.staff_members?.findFirst?.({
    where: { id: req.actingStaff.id, is_active: true },
    select: { id: true, role: true, store_id: true },
  })
  if (!staff || staff.role !== req.actingStaff.role) return null
  req.actingStaff.storeId = staff.store_id
  return staff.store_id
}

/**
 * storeContextMiddleware — resolves WHICH STORE this request acts on.
 *
 * Phase 8 model: a tenant is a business; a store is one of its shops.
 * `req.user.storeId` is the staff member's MEMBERSHIP (one person, one shop —
 * migration 0042). This middleware resolves the ACTIVE store for the request,
 * which is only ever different from membership for an owner.
 *
 * Rules, all enforced here rather than in the UI:
 *   - No X-Store-Id header  -> act in your own shop.
 *   - X-Store-Id: all       -> OWNER ONLY. Business-wide READ scope, for the
 *                              combined dashboard and reports. activeStoreId is
 *                              null, so a write path calling activeStoreId()
 *                              throws instead of silently picking a shop.
 *   - owner                 -> may name any ACTIVE store of their own tenant.
 *   - manager / cashier     -> may only name their own shop; anything else 403.
 *
 * Business scope is deliberately OPT-IN rather than the owner's default. An
 * owner standing at their own till must be able to sell without thinking about
 * scope, and a default that silently aggregated would make every write path
 * depend on a header being absent.
 *
 * SECURITY: the header is a REQUEST, never an authority. Same discipline as
 * authMiddleware's T-1-01 note — an owner's claim to a store is checked against
 * the database under their own tenant scope, so RLS itself refuses a store
 * belonging to another business. A non-owner's claim is checked against their
 * verified membership and never hits the database at all.
 *
 * Mount AFTER authMiddleware; it depends on req.user.
 */
export async function storeContextMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const requested = requestedStoreId(req)
  const role = effectiveRole(req)
  const membershipStoreId = await effectiveMembershipStoreId(req)
  if (!role || !membershipStoreId) {
    return res.status(401).json({ error: 'Invalid operator session' })
  }

  // A PIN-switched manager/cashier may only operate on the counter's store.
  // Owners are tenant-wide and remain free to move between stores.
  if (req.actingStaff && role !== 'owner' && req.accessContext?.pairedTerminalId) {
    const terminal = await (forTenant(req.user.tenantId) as any).terminals?.findFirst?.({
      where: { id: req.accessContext.pairedTerminalId, is_active: true },
      select: { store_id: true },
    })
    if (!terminal || terminal.store_id !== membershipStoreId) {
      return res.status(403).json({ error: 'This operator belongs to a different store' })
    }
  }

  // Default: everyone acts in their own shop. This is the overwhelmingly common
  // path — cashiers and managers never send the header at all.
  if (!requested || requested === membershipStoreId) {
    req.storeContext = {
      scope: 'store',
      activeStoreId: membershipStoreId,
      actingRemotely: false,
    }
    return next()
  }

  // Business-wide read scope, for the owner's combined dashboard and reports.
  if (requested.toLowerCase() === 'all') {
    if (role !== 'owner') {
      return res.status(403).json({ error: 'You can only act in your own store' })
    }
    req.storeContext = { scope: 'business', activeStoreId: null, actingRemotely: false }
    return next()
  }

  // Reject malformed input before it reaches the database.
  if (!UUID_PATTERN.test(requested)) {
    return res.status(400).json({ error: 'Invalid store id' })
  }

  // Only an owner may operate outside their own shop. A manager or cashier
  // naming another shop is not a bad request — it is an authorization failure,
  // and it is the exact attempt this phase exists to refuse.
  if (role !== 'owner') {
    return res.status(403).json({ error: 'You can only act in your own store' })
  }

  // Tenant-scoped, so RLS refuses another business's store id outright — this
  // lookup cannot be tricked into confirming a store the owner does not own.
  const store = await forTenant(req.user.tenantId).stores.findFirst({
    where: { id: requested, is_active: true },
    select: { id: true },
  })

  if (!store) {
    // Deliberately does not distinguish "not yours" from "does not exist" or
    // "deactivated" — that difference is only useful to someone probing for
    // other tenants' store ids.
    return res.status(403).json({ error: 'Store not found for this business' })
  }

  req.storeContext = { scope: 'store', activeStoreId: store.id, actingRemotely: true }
  next()
}

/**
 * The store this request acts on. Use for every WRITE and for any read that
 * concerns one shop.
 *
 * Throws rather than returning a fallback, in both failure cases:
 *   - middleware not mounted -> the route would read/write an arbitrary shop
 *   - business scope         -> there is no single shop to write to
 * Either would be a silent wrong-shop write, the worst thing this phase can do.
 */
export function activeStoreId(req: Request): string {
  const context = req.storeContext
  if (!context) {
    throw new Error(
      'storeContextMiddleware must be mounted before any store-scoped route',
    )
  }
  if (context.scope === 'business' || !context.activeStoreId) {
    throw new Error(
      'This operation concerns a single store, but the request asked for business-wide scope',
    )
  }
  return context.activeStoreId
}

/**
 * A Prisma `where` fragment scoping a query to the request's store, or `{}` for
 * business-wide reads.
 *
 * Use ONLY on read paths that are genuinely meaningful aggregated across shops
 * (the owner's combined dashboard, business-level reports). Anything that
 * concerns one shop — and every write — must use activeStoreId() so that
 * business scope throws instead of quietly spanning shops.
 */
export function storeScopeWhere(req: Request): { store_id?: string } {
  const context = req.storeContext
  if (!context) {
    throw new Error(
      'storeContextMiddleware must be mounted before any store-scoped route',
    )
  }
  return context.scope === 'business' ? {} : { store_id: context.activeStoreId! }
}
