import express from 'express'
import routes from './routes'
import { errorHandler } from './middleware/errorHandler'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api', routes)

// Error middleware must be registered LAST, after all routes.
app.use(errorHandler)

const PORT = process.env.PORT ?? 4000
if (require.main === module) {
  app.listen(PORT, () => console.log(`backend listening on :${PORT}`))
}

export { app }
