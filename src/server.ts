// Must load before any other import — routes/auth.ts and middleware/auth.ts
// construct Supabase clients from process.env at module-load time, so .env
// has to be populated before those modules are first required. Tests and
// prisma.config.ts already did this explicitly; the app entrypoint itself
// never did, so `npm run dev` crashed with "supabaseUrl is required."
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import routes from './routes'
import { errorHandler } from './middleware/errorHandler'
import { razorpayWebhookHandler } from './routes/razorpayWebhook'

const app = express()

// CORS (WR-06 fix): the frontend (Next.js) runs on its own origin/port and
// calls this API directly via NEXT_PUBLIC_API_URL, so without an explicit
// Access-Control-Allow-Origin response header, every cross-origin frontend
// request is blocked by the browser's same-origin policy.
//
// CORS_ORIGIN is a comma-separated allowlist of exact origins (scheme +
// host + port), driven by env rather than hardcoded/wildcard, so each
// deployment (local dev, staging, prod) can configure its own frontend
// origin(s) without a code change. Defaults to the local Next.js dev server
// origins if unset.
const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
)
// 8 MB accommodates a base64-encoded CSV at the import service's 5 MB file cap
// (base64 inflates by ~4/3). The real limit that matters is enforced in
// csv-parse.ts, which reports an over-sized file as such instead of the
// body parser rejecting it as malformed JSON.
// Razorpay signs the exact request bytes. This route must consume the raw
// body before the application-wide JSON parser runs.
app.post(
  '/api/billing/razorpay/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  razorpayWebhookHandler,
)
app.use(express.json({ limit: '8mb' }))

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

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10)
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`backend listening on 127.0.0.1:${PORT}`))
}

export { app }
