import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { HardwareHeartbeatSchema, HardwareJobResultSchema, HardwarePairSchema } from '../contracts/schemas/hardware'

const router = Router()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function decoded(value: string): { tenantId: string; secret: string } | null { try { const data = JSON.parse(Buffer.from(value, 'base64url').toString()); return typeof data.tenantId === 'string' && typeof data.secret === 'string' ? data : null } catch { return null } }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function token(req: any) { const value = req.header('authorization'); return value?.startsWith('Bearer ') ? decoded(value.slice(7)) : null }
async function authenticated(req: any, res: any, next: any) { const value = token(req); if (!value) return res.status(401).json({ error: 'Companion token required.' }); const row = await forTenant(value.tenantId).hardware_companions.findFirst({ where: { token_hash: hash(value.secret), revoked_at: null } }); if (!row) return res.status(401).json({ error: 'Companion token is invalid or revoked.' }); req.companion = row; req.companionTenantId = value.tenantId; next() }

router.post('/pair', async (req, res) => {
  const parsed = HardwarePairSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid pairing request.' })
  const code = decoded(parsed.data.pairingCode); if (!code || !UUID_PATTERN.test(code.tenantId)) return res.status(400).json({ error: 'Pairing code is invalid.' })
  const row = await forTenant(code.tenantId).hardware_pairing_codes.findFirst({ where: { code_hash: hash(code.secret), used_at: null, expires_at: { gt: new Date() } } })
  if (!row) return res.status(410).json({ error: 'Pairing code expired or was already used.' })
  const secret = randomBytes(32).toString('base64url')
  const companion = await forTenantTransaction(code.tenantId, async (tx) => {
    await tx.hardware_companions.updateMany({ where: { terminal_id: row.terminal_id, revoked_at: null }, data: { revoked_at: new Date() } })
    const created = await tx.hardware_companions.create({ data: { tenant_id: code.tenantId, store_id: row.store_id, terminal_id: row.terminal_id, token_hash: hash(secret), machine_name: parsed.data.machineName, os: parsed.data.os, version: parsed.data.version, capabilities: parsed.data.capabilities, last_seen_at: new Date() } })
    await tx.hardware_pairing_codes.update({ where: { id: row.id }, data: { used_at: new Date() } }); return created
  })
  const companionToken = Buffer.from(JSON.stringify({ tenantId: code.tenantId, secret })).toString('base64url')
  return res.status(201).json({ companionId: companion.id, terminalId: companion.terminal_id, token: companionToken })
})
router.use(authenticated)
router.post('/heartbeat', async (req: any, res) => { const parsed = HardwareHeartbeatSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid heartbeat.' }); await forTenant(req.companionTenantId).hardware_companions.update({ where: { id: req.companion.id }, data: { last_seen_at: new Date(), version: parsed.data.version, capabilities: parsed.data.capabilities } }); return res.json({ ok: true, serverTime: new Date().toISOString() }) })
router.get('/jobs/next', async (req: any, res) => {
  const staleBefore = new Date(Date.now() - 2 * 60_000)
  const job = await forTenantTransaction(req.companionTenantId, async (tx) => {
    const candidate = await tx.hardware_jobs.findFirst({
      where: {
        companion_id: req.companion.id,
        attempts: { lt: 3 },
        OR: [
          { status: 'queued' },
          { status: 'claimed', claimed_at: { lt: staleBefore } },
        ],
      },
      orderBy: { created_at: 'asc' },
    })
    if (!candidate) return null
    return tx.hardware_jobs.update({
      where: { id: candidate.id },
      data: { status: 'claimed', attempts: { increment: 1 }, claimed_at: new Date() },
    })
  })
  return res.json(job ? { id: job.id, kind: job.kind, payload: job.payload, attempt: job.attempts } : null)
})

router.post('/jobs/:id/result', async (req: any, res) => {
  const parsed = HardwareJobResultSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid job result.' })
  const job = await forTenant(req.companionTenantId).hardware_jobs.findFirst({
    where: { id: req.params.id, companion_id: req.companion.id, status: 'claimed' },
  })
  if (!job) return res.status(409).json({ error: 'Job is not claimed by this Companion.' })
  const retrying = parsed.data.status === 'failed' && job.attempts < 3
  await forTenant(req.companionTenantId).hardware_jobs.update({
    where: { id: job.id },
    data: retrying
      ? { status: 'queued', error_message: parsed.data.error ?? 'Hardware command failed', claimed_at: null }
      : { status: parsed.data.status, error_message: parsed.data.error ?? null, completed_at: new Date() },
  })
  return res.json({ ok: true, retrying })
})
export default router
