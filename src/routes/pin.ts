import { Router } from 'express'
import { z } from 'zod'
import { validatePin, signOperatorToken } from '../middleware/pinSwitch'

const router = Router()

const switchBodySchema = z.object({
  staffId: z.string(),
  pin: z.string(),
})

/**
 * POST /switch — PIN-switch the acting operator on a shared terminal.
 * Requires authMiddleware to have already run (the terminal's own
 * long-lived owner/manager session). Does NOT create a new Supabase Auth
 * session — issues a short-lived signed operator token instead (D-09/D-10).
 *
 * SECURITY (T-1-09): 'not_found' and 'incorrect' map to the SAME generic
 * error copy so an attacker cannot distinguish "PIN not yet provisioned"
 * from "wrong PIN".
 */
router.post('/switch', async (req, res) => {
  const parsed = switchBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { staffId, pin } = parsed.data
  const result = await validatePin(req.user.tenantId, staffId, pin)

  if (!result.ok) {
    const message =
      result.reason === 'locked'
        ? 'Too many attempts. Ask a manager to unlock this terminal.'
        : 'Incorrect PIN — try again.'
    return res.status(401).json({ error: message })
  }

  return res.status(200).json({
    operatorToken: signOperatorToken(result.staff, req.user.tenantId),
    staff: result.staff,
  })
})

export default router
