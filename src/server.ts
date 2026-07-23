import express from 'express'
import routes from './routes'
import { errorHandler } from './middleware/errorHandler'
import { operatorContext } from './middleware/operatorContext'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// operatorContext reads an independent header (X-Operator-Token) and doesn't
// itself require authMiddleware to have run first, but it must run before
// any route that calls requireRole (every tenant-scoped route in this
// phase), so req.actingStaff is available everywhere requireRole checks it.
app.use(operatorContext)

app.use('/api', routes)

// Error middleware must be registered LAST, after all routes.
app.use(errorHandler)

const PORT = process.env.PORT ?? 4000
if (require.main === module) {
  app.listen(PORT, () => console.log(`backend listening on :${PORT}`))
}

export { app }
