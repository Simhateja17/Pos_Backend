import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import authRouter from './auth'
import pinRouter from './pin'
import membersRouter from './members'

const router = Router()

// /auth/* (signup, login) is deliberately NOT gated by authMiddleware — a
// caller has no session yet when signing up or logging in.
router.use('/auth', authRouter)

// /terminal/pin/* (PIN-switch) and /members/* both require an already
// authenticated terminal session (the owner/manager who is logged in on this
// terminal) — authMiddleware runs first to populate req.user, then
// operatorContext (mounted globally in server.ts) may further populate
// req.actingStaff for requireRole's acting-identity check.
router.use('/terminal/pin', authMiddleware, pinRouter)
router.use('/members', authMiddleware, membersRouter)

export default router
