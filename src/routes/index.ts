import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import { operatorContext } from '../middleware/operatorContext'
import authRouter from './auth'
import pinRouter from './pin'
import membersRouter from './members'
import productsRouter from './products'
import masterItemsRouter from './masterItems'
import categoriesRouter from './categories'
import terminalsRouter from './terminals'
import settingsRouter from './settings'
import notificationsRouter from './notifications'
import stockMovementsRouter from './stockMovements'
import salesRouter from './sales'
import returnsRouter from './returns'
import taxDocumentsRouter from './taxDocuments'
import customersRouter from './customers'
import receivablesRouter from './receivables'
import shiftsRouter from './shifts'
import onboardingRouter from './onboarding'
import contextRouter from './context'
import dashboardRouter from './dashboard'
import suppliersRouter from './suppliers'
import supplierProductsRouter from './supplier-products'
import purchaseOrdersRouter from './purchase-orders'
import reorderRouter from './reorder'
import importRouter from './import'
import reportsRouter from './reports'
import emailRouter from './email'
import billingRouter from './billing'
import publicPlansRouter from './publicPlans'
import storesRouter from './stores'
import availabilityRouter from './availability'
import transfersRouter from './transfers'
import { requireSubscription } from '../middleware/requireSubscription'
import { requireRole } from '../middleware/requireRole'
import { requireOperatorOnPairedDevice } from '../middleware/requireOperatorOnPairedDevice'
import { storeContextMiddleware } from '../middleware/storeContext'
import setupRouter from './setup'
import hardwareRouter from './hardware'
import hardwareCompanionRouter from './hardwareCompanion'
import adminRouter, { supportReadOnlyRouter } from './admin'
import merchantSupportRouter from './support'

const router = Router()

// /auth/* (signup, login) is deliberately NOT gated by authMiddleware — a
// caller has no session yet when signing up or logging in.
router.use('/auth', authRouter)

// /public/* is the marketing site's surface: no session, no tenant, region
// comes from the caller's own IP/switcher detection. Kept out of /billing so
// the tenant-aware, auth-gated /billing/plans route above is never confused
// with this one.
router.use('/public', publicPlansRouter)
// Merchant consent requests use the normal merchant Supabase session.  They
// are deliberately separate from /admin so an employee is never represented
// as a merchant staff member or issued a merchant JWT.
router.use('/support', merchantSupportRouter)
// A support-session token is a short-lived, read-only server token minted only
// after merchant consent. Mount it on the narrow `/sessions` prefix so the
// Admin router's `/support/requests` consent queue is never intercepted by
// the support-session bearer-token middleware.
router.use('/admin/support/sessions', supportReadOnlyRouter)
router.use('/admin', adminRouter)
// The installed Companion authenticates with its own revocable, high-entropy
// machine token rather than a staff browser session.
router.use('/hardware/companion', hardwareCompanionRouter)

// /terminal/pin/* (PIN-switch) and /members/* both require an already
// authenticated terminal session (the owner/manager who is logged in on this
// terminal) — authMiddleware runs first to populate req.user (from a
// verified JWT), THEN operatorContext runs to populate req.actingStaff for
// requireRole's acting-identity check. operatorContext MUST run after
// authMiddleware (CR-01 fix): it verifies the operator token's tenant_id
// claim against req.user.tenantId, so it depends on req.user already being
// populated from a trusted source.
router.use('/terminal/pin', authMiddleware, requireSubscription, operatorContext, storeContextMiddleware, pinRouter)
// /members additionally needs storeContextMiddleware: creating a staff member
// writes staff_members.store_id (NOT NULL since 0042), so the route must know
// which shop it is acting in. It is added here rather than by adopting
// `appAccess` wholesale because /members must stay reachable during
// first-PIN-setup, i.e. before this browser is paired to a counter — which is
// exactly what appAccess's requireOperatorOnPairedDevice forbids.
// storeContextMiddleware itself only depends on req.user, so it is safe here.
router.use('/members', authMiddleware, requireSubscription, operatorContext, storeContextMiddleware, membersRouter)
router.use('/terminals', authMiddleware, requireSubscription, operatorContext, storeContextMiddleware, terminalsRouter)

// Once a browser is paired to a counter, the organisation login remains the
// durable device session but cannot authorize app work by itself. A verified
// staff PIN session is required before any operational or admin API below.
// storeContextMiddleware resolves WHICH SHOP the request acts on (Phase 8).
// It sits in appAccess so every operational route below gets req.storeContext
// without opting in — a store-scoped route that forgot to mount it would read
// or write against the wrong shop, which is the worst failure this phase can
// produce. activeStoreId() throws rather than defaulting, for the same reason.
const appAccess = [authMiddleware, requireSubscription, operatorContext, requireOperatorOnPairedDevice, storeContextMiddleware]

// Management surfaces are reachable during first-time setup on an unpaired
// browser, but a browser that is already assigned to a counter still needs a
// verified owner/manager PIN. Business-wide scope is allowed through this
// guard so the route itself can return its deterministic `choose_store` 400
// before a pairing check turns it into a register-lock response.
function requireOperatorOnSpecificStore(req: Parameters<typeof requireOperatorOnPairedDevice>[0], res: Parameters<typeof requireOperatorOnPairedDevice>[1], next: Parameters<typeof requireOperatorOnPairedDevice>[2]) {
  if (req.storeContext?.scope === 'business') return next()
  return requireOperatorOnPairedDevice(req, res, next)
}

router.use('/stores', ...appAccess, storesRouter)
// Cross-shop availability is open to EVERY role, cashiers included — it is
// the point of being a chain. It returns quantity only; see the route.
// Mounted on its own path rather than inside productsRouter because
// products' own '/:productId' handler would otherwise swallow '/variants'.
router.use('/variants/:variantId/availability', ...appAccess, availabilityRouter)
router.use('/products', ...appAccess, productsRouter)
router.use('/master-items', ...appAccess, requireRole('manager'), masterItemsRouter)
router.use('/categories', ...appAccess, categoriesRouter)
router.use('/sales', ...appAccess, salesRouter)
router.use('/returns', ...appAccess, returnsRouter)
// GST documents are readable by cashiers for their current store and by
// managers/owners within the store/business scope resolved above. Creation is
// idempotent and lazy, so an older sale can receive its invoice on first read.
router.use('/tax-documents', ...appAccess, taxDocumentsRouter)
router.use('/customers', ...appAccess, customersRouter)
router.use('/receivables', ...appAccess, receivablesRouter)
router.use('/shifts', ...appAccess, shiftsRouter)

// Back-office modules are also server-gated. Filtering the sidebar is only a
// convenience; a cashier who types these URLs or calls the APIs still gets a
// 403 from requireRole.
// Settings is a management surface, but unlike operational reads it must
// return a clean 403 to cashiers before the shared-register lock (423) is
// considered.  It also needs to be usable during first-time setup on an
// unpaired browser, so the route has its own ordered access chain.
router.use('/settings', authMiddleware, operatorContext, storeContextMiddleware, requireRole('manager'), requireOperatorOnSpecificStore, requireSubscription, settingsRouter)
router.use('/notifications', ...appAccess, requireRole('manager'), notificationsRouter)
router.use('/stock-movements', ...appAccess, requireRole('manager'), stockMovementsRouter)
router.use('/transfers', ...appAccess, requireRole('manager'), transfersRouter)
router.use('/dashboard', ...appAccess, requireRole('manager'), dashboardRouter)
router.use('/suppliers', ...appAccess, requireRole('manager'), suppliersRouter)
router.use('/variants/:variantId/supplier-products', ...appAccess, requireRole('manager'), supplierProductsRouter)
router.use('/purchase-orders', ...appAccess, requireRole('manager'), purchaseOrdersRouter)
router.use('/reorder', ...appAccess, requireRole('manager'), reorderRouter)
router.use('/import', ...appAccess, requireRole('manager'), importRouter)
router.use('/reports', ...appAccess, requireRole('manager'), reportsRouter)
router.use('/email', ...appAccess, requireRole('manager'), emailRouter)

// Guided setup is intentionally available before terminal pairing.  It never
// authorizes a sale; the existing billing/operator/shift gates remain the
// authority for checkout.  A store context is still mandatory so setup state
// cannot bleed between outlets.
router.use('/setup', authMiddleware, operatorContext, storeContextMiddleware, requireRole('manager'), requireOperatorOnSpecificStore, setupRouter)
router.use('/hardware', authMiddleware, requireSubscription, operatorContext, storeContextMiddleware, requireRole('manager'), requireOperatorOnSpecificStore, hardwareRouter)

router.use('/onboarding', authMiddleware, operatorContext, requireOperatorOnPairedDevice, requireRole('manager'), onboardingRouter)
router.use('/billing', authMiddleware, operatorContext, requireOperatorOnPairedDevice, billingRouter)
// Context precedes read-model routers so the authenticated app shell can
// establish its server-owned identity before record pages request data.
router.use('/context', authMiddleware, operatorContext, requireOperatorOnPairedDevice, storeContextMiddleware, contextRouter)

export default router
