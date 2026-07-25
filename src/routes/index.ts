import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import { operatorContext } from '../middleware/operatorContext'
import authRouter from './auth'
import pinRouter from './pin'
import membersRouter from './members'
import productsRouter from './products'
import stockMovementsRouter from './stockMovements'
import salesRouter from './sales'
import returnsRouter from './returns'
import customersRouter from './customers'
import shiftsRouter from './shifts'
import onboardingRouter from './onboarding'
import contextRouter from './context'
import dashboardRouter from './dashboard'
import suppliersRouter from './suppliers'
import purchaseOrdersRouter from './purchase-orders'
import reorderRouter from './reorder'
import importRouter from './import'

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
router.use('/terminal/pin', authMiddleware, operatorContext, pinRouter)
router.use('/members', authMiddleware, operatorContext, membersRouter)
router.use('/products', authMiddleware, operatorContext, productsRouter)
router.use('/stock-movements', authMiddleware, operatorContext, stockMovementsRouter)
router.use('/sales', authMiddleware, operatorContext, salesRouter)
router.use('/returns', authMiddleware, operatorContext, returnsRouter)
router.use('/customers', authMiddleware, operatorContext, customersRouter)
router.use('/shifts', authMiddleware, operatorContext, shiftsRouter)
router.use('/onboarding', authMiddleware, operatorContext, onboardingRouter)
// Context precedes read-model routers so the authenticated app shell can
// establish its server-owned identity before record pages request data.
router.use('/context', authMiddleware, operatorContext, contextRouter)
router.use('/dashboard', authMiddleware, operatorContext, dashboardRouter)
router.use('/suppliers', authMiddleware, operatorContext, suppliersRouter)
router.use('/purchase-orders', authMiddleware, operatorContext, purchaseOrdersRouter)
router.use('/reorder', authMiddleware, operatorContext, reorderRouter)
router.use('/import', authMiddleware, operatorContext, importRouter)

export default router
