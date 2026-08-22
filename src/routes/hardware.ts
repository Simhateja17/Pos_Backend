import { createHash, randomBytes } from 'node:crypto'
import { Router } from 'express'
import { activeStoreId } from '../middleware/storeContext'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { CreateHardwarePairingSchema, CreateHardwareTestJobSchema } from '../contracts/schemas/hardware'
import { getCounterDeviceToken, hashCounterDeviceToken } from '../lib/counterDevice'

const router = Router()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const staffId = (req: any) => req.actingStaff?.id ?? null

router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const storeId = activeStoreId(req)
  const deviceToken = getCounterDeviceToken(req)
  const deviceHash = deviceToken ? hashCounterDeviceToken(deviceToken) : null
  const [terminals, companions, jobs] = await Promise.all([
    client.terminals.findMany({ where: { store_id: storeId, is_active: true }, orderBy: { name: 'asc' } }),
    client.hardware_companions.findMany({ where: { store_id: storeId, revoked_at: null }, orderBy: { created_at: 'desc' } }),
    client.hardware_jobs.findMany({ where: { store_id: storeId }, orderBy: { created_at: 'desc' }, take: 20 }),
  ])
  res.json({
    terminals: terminals.map((row: any) => ({ id: row.id, name: row.name, cashMode: row.cash_mode, isCurrentDevice: Boolean(deviceHash && row.device_token_hash === deviceHash) })),
    companions: companions.map((row: any) => ({ id: row.id, terminalId: row.terminal_id, machineName: row.machine_name, os: row.os, version: row.version, capabilities: row.capabilities, lastSeenAt: row.last_seen_at?.toISOString() ?? null, online: Boolean(row.last_seen_at && Date.now() - row.last_seen_at.getTime() < 90_000) })),
    jobs: jobs.map((row: any) => ({ id: row.id, terminalId: row.terminal_id, kind: row.kind, status: row.status, attempts: row.attempts, error: row.error_message, createdAt: row.created_at.toISOString() })),
  })
})

router.post('/pairing-codes', async (req, res) => {
  const parsed = CreateHardwarePairingSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Choose a valid counter.' })
  const tenantId = req.user!.tenantId
  const storeId = activeStoreId(req)
  const secret = randomBytes(18).toString('base64url')
  const terminal = await forTenant(tenantId).terminals.findFirst({ where: { id: parsed.data.terminalId, store_id: storeId, is_active: true } })
  if (!terminal) return res.status(404).json({ error: 'Counter not found.' })
  const expiresAt = new Date(Date.now() + 10 * 60_000)
  await forTenant(tenantId).hardware_pairing_codes.create({ data: { tenant_id: tenantId, store_id: storeId, terminal_id: terminal.id, code_hash: hash(secret), expires_at: expiresAt, created_by: staffId(req) } })
  const pairingCode = Buffer.from(JSON.stringify({ tenantId, secret })).toString('base64url')
  return res.status(201).json({ pairingCode, expiresAt: expiresAt.toISOString(), terminalId: terminal.id })
})

router.post('/jobs', async (req, res) => {
  const parsed = CreateHardwareTestJobSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid hardware test.' })
  const tenantId = req.user!.tenantId
  const storeId = activeStoreId(req)
  const companion = await forTenant(tenantId).hardware_companions.findFirst({ where: { terminal_id: parsed.data.terminalId, store_id: storeId, revoked_at: null } })
  if (!companion) return res.status(409).json({ error: 'Pair an online Companion to this counter first.' })
  const job = await forTenant(tenantId).hardware_jobs.create({ data: { tenant_id: tenantId, store_id: storeId, terminal_id: parsed.data.terminalId, companion_id: companion.id, kind: parsed.data.kind, payload: parsed.data.payload, idempotency_key: `test:${randomBytes(16).toString('hex')}`, created_by: staffId(req) } })
  return res.status(202).json({ id: job.id, status: job.status })
})

router.delete('/companions/:id', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const companion = await client.hardware_companions.findFirst({ where: { id: req.params.id, store_id: activeStoreId(req), revoked_at: null } })
  if (!companion) return res.status(404).json({ error: 'Companion not found.' })
  await forTenantTransaction(req.user!.tenantId, async (tx) => {
    await tx.hardware_companions.update({ where: { id: companion.id }, data: { revoked_at: new Date() } })
    await tx.hardware_jobs.updateMany({ where: { companion_id: companion.id, status: { in: ['queued','claimed'] } }, data: { status: 'cancelled', error_message: 'Companion revoked' } })
  })
  return res.status(204).end()
})
export default router
