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
