import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import { operatorContext } from '../middleware/operatorContext'
import authRouter from './auth'
import pinRouter from './pin'
import membersRouter from './members'
import productsRouter from './products'
import categoriesRouter from './categories'
import terminalsRouter from './terminals'
import settingsRouter from './settings'
import notificationsRouter from './notifications'
import stockMovementsRouter from './stockMovements'
import salesRouter from './sales'
import returnsRouter from './returns'
import customersRouter from './customers'
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
import storesRouter from './stores'
import { requireSubscription } from '../middleware/requireSubscription'
import { requireRole } from '../middleware/requireRole'
import { requireOperatorOnPairedDevice } from '../middleware/requireOperatorOnPairedDevice'
import { storeContextMiddleware } from '../middleware/storeContext'

const router = Router()

// /auth/* (signup, login) is deliberately NOT gated by authMiddleware — a
// caller has no session yet when signing up or logging in.
router.use('/auth', authRouter)

// /terminal/pin/* (PIN-switch) and /members/* both require an already
// authenticated terminal session (the owner/manager who is logged in on this
// terminal) — authMiddleware runs first to populate req.user (from a
// verified JWT), THEN operatorContext runs to populate req.actingStaff for
// requireRole's acting-identity check. operatorContext MUST run after
// authMiddleware (CR-01 fix): it verifies the operator token's tenant_id
// claim against req.user.tenantId, so it depends on req.user already being
// populated from a trusted source.
router.use('/terminal/pin', authMiddleware, requireSubscription, operatorContext, pinRouter)
router.use('/members', authMiddleware, requireSubscription, operatorContext, membersRouter)
router.use('/terminals', authMiddleware, requireSubscription, operatorContext, terminalsRouter)

// Once a browser is paired to a counter, the organisation login remains the
// durable device session but cannot authorize app work by itself. A verified
// staff PIN session is required before any operational or admin API below.
// storeContextMiddleware resolves WHICH SHOP the request acts on (Phase 8).
// It sits in appAccess so every operational route below gets req.storeContext
// without opting in — a store-scoped route that forgot to mount it would read
// or write against the wrong shop, which is the worst failure this phase can
// produce. activeStoreId() throws rather than defaulting, for the same reason.
const appAccess = [authMiddleware, requireSubscription, operatorContext, requireOperatorOnPairedDevice, storeContextMiddleware]
router.use('/stores', ...appAccess, storesRouter)
router.use('/products', ...appAccess, productsRouter)
router.use('/categories', ...appAccess, categoriesRouter)
router.use('/sales', ...appAccess, salesRouter)
router.use('/returns', ...appAccess, returnsRouter)
router.use('/customers', ...appAccess, customersRouter)
router.use('/shifts', ...appAccess, shiftsRouter)

// Back-office modules are also server-gated. Filtering the sidebar is only a
// convenience; a cashier who types these URLs or calls the APIs still gets a
// 403 from requireRole.
router.use('/settings', ...appAccess, requireRole('manager'), settingsRouter)
router.use('/notifications', ...appAccess, requireRole('manager'), notificationsRouter)
router.use('/stock-movements', ...appAccess, requireRole('manager'), stockMovementsRouter)
router.use('/dashboard', ...appAccess, requireRole('manager'), dashboardRouter)
router.use('/suppliers', ...appAccess, requireRole('manager'), suppliersRouter)
router.use('/variants/:variantId/supplier-products', ...appAccess, requireRole('manager'), supplierProductsRouter)
router.use('/purchase-orders', ...appAccess, requireRole('manager'), purchaseOrdersRouter)
router.use('/reorder', ...appAccess, requireRole('manager'), reorderRouter)
router.use('/import', ...appAccess, requireRole('manager'), importRouter)
router.use('/reports', ...appAccess, requireRole('manager'), reportsRouter)
router.use('/email', ...appAccess, requireRole('manager'), emailRouter)

router.use('/onboarding', authMiddleware, operatorContext, requireOperatorOnPairedDevice, requireRole('manager'), onboardingRouter)
router.use('/billing', authMiddleware, operatorContext, requireOperatorOnPairedDevice, billingRouter)
// Context precedes read-model routers so the authenticated app shell can
// establish its server-owned identity before record pages request data.
router.use('/context', authMiddleware, operatorContext, requireOperatorOnPairedDevice, contextRouter)

export default router
