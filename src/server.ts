import express from 'express'
import routes from './routes'
import { errorHandler } from './middleware/errorHandler'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// operatorContext (CR-01 fix) now requires req.user to already be populated
// (it verifies the token's tenant_id against req.user.tenantId), so it is no
// longer mounted globally here ahead of authMiddleware. It's mounted per-route
// in routes/index.ts, directly after authMiddleware, on every route that uses
// requireRole/req.actingStaff.
app.use('/api', routes)

// Error middleware must be registered LAST, after all routes.
app.use(errorHandler)

const PORT = process.env.PORT ?? 4000
if (require.main === module) {
  app.listen(PORT, () => console.log(`backend listening on :${PORT}`))
}

export { app }
