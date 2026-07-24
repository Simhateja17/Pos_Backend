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

export default router
