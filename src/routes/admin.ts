import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import {
  AdminAuditQuerySchema,
  AdminEntitlementOverrideSchema,
  AdminInviteSchema,
  AdminListSchema,
  AdminMfaResetSchema,
  AdminOtpRequestSchema,
  AdminOtpVerifySchema,
  AdminPrivateOfferSchema,
  AdminRetrySchema,
  AdminSearchSchema,
  AdminSupportRequestSchema,
  AdminTenantIdSchema,
  AdminRevokeOverrideSchema,
} from '../contracts/schemas/admin'
import { createRazorpayPlan, RazorpayRequestError } from '../services/razorpay'
import { getBillingMode } from '../services/billingCatalog'
import { snapshotForPlan } from '../services/entitlements'
import {
  adminPanelEnabled,
  backendAdminRegion,
  countActivePlatformOwners,
  countAdminRows,
  createPlatformAdmin,
  deleteAdminFactor,
  findPlatformAdminByEmail,
  findPlatformAdminByUserId,
  getPlatformAdmin,
  getSupportRequest,
  insertAuditEvent,
  insertEntitlementOverride,
  insertOperationRetry,
  insertSupportRequest,
  inviteAuthUser,
  listAdminFactors,
  listRegionalTenants,
  listPlatformAdmins,
  listSupportRequests,
  privilegedSupabase,
  queryAdminRows,
  queryAdminSingle,
  revokeEntitlementOverride,
  requestAdminOtp,
  signOutAdminToken,
  updateAdminRows,
  updatePlatformAdmin,
  updateSupportRequest,
  verifyAdminOtp,
  type PlatformAdmin,
} from '../services/adminStore'
import {
  allowAdminAal1,
  adminAuthMiddleware,
  requireAdminAal2,
  requireAdminRole,
  requireFreshAdminStepUp,
} from '../middleware/adminAuth'

const router = Router()
const protectedRouter = Router()

function requestMetadata(req: Request) {
  return {
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent')?.slice(0, 1_000) ?? null,
    requestId: req.get('x-request-id')?.slice(0, 200) ?? null,
  }
}

async function audit(req: Request, action: string, extra: Record<string, unknown> = {}) {
  await insertAuditEvent({
    administratorId: req.admin?.id ?? null,
    action,
    ...requestMetadata(req),
    ...extra,
  })
}

function adminAvailability(res: Response): boolean {
  if (!adminPanelEnabled()) {
    res.status(404).json({ error: 'Admin Panel is disabled' })
    return false
  }
  try {
    backendAdminRegion()
  } catch {
    res.status(503).json({ error: 'Admin Panel is not configured for this region' })
    return false
  }
  return true
}

function safeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function regionalTenant(tenant: Record<string, unknown> | null): boolean {
  if (!tenant) return false
  const country = String(tenant.country ?? '').trim().toUpperCase()
  return backendAdminRegion() === 'IN' ? country === 'IN' : country !== 'IN'
}

async function getRegionalTenant(tenantId: string): Promise<Record<string, unknown> | null> {
  const tenant = await queryAdminSingle<Record<string, unknown>>('tenants', (query) => query.eq('id', tenantId))
  return regionalTenant(tenant) ? tenant : null
}

function adminTaxRateBps(): number {
  const region = backendAdminRegion()
  if (region === 'IN') return 1_800
  const configured = Number.parseInt(process.env.INTERNATIONAL_SUBSCRIPTION_TAX_RATE_BPS ?? process.env.US_SUBSCRIPTION_TAX_RATE_BPS ?? '0', 10)
  return Number.isFinite(configured) && configured >= 0 ? configured : 0
}

async function regionalTenantIds(): Promise<string[]> {
  const tenants = await queryAdminRows<Record<string, unknown>>('tenants', (query) => query)
  return tenants
    .filter(regionalTenant)
    .map((tenant) => typeof tenant.id === 'string' ? tenant.id : null)
    .filter((id): id is string => Boolean(id))
}

function publicAdmin(admin: PlatformAdmin) {
  return {
    id: admin.id,
    email: admin.email,
    displayName: admin.display_name,
    role: admin.role,
    region: admin.region,
    status: admin.status,
    invitedAt: admin.invited_at,
    activatedAt: admin.activated_at,
    suspendedAt: admin.suspended_at,
  }
}

function supportSessionSecret(): string {
  const secret = process.env.ADMIN_SUPPORT_SESSION_SECRET?.trim() || process.env.SUPABASE_JWT_SECRET?.trim()
  if (!secret) throw new Error('ADMIN_SUPPORT_SESSION_SECRET is required')
  return secret
}

function hashSupportToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function boundedExpiry(expiresAt: Date): boolean {
  const now = Date.now()
  const max = now + 30 * 24 * 60 * 60 * 1_000
  return expiresAt.getTime() > now && expiresAt.getTime() <= max
}

async function operationExists(kind: string, operationId: string): Promise<Record<string, unknown> | null> {
  const table = kind === 'webhook'
    ? 'billing_webhook_events'
    : kind === 'email'
      ? 'email_log'
      : kind === 'import'
        ? 'import_batches'
        : 'forecast_runs'
  return queryAdminSingle<Record<string, unknown>>(table, (query) => query.eq('id', operationId))
}

async function supportRequestForAdmin(req: Request, id: string) {
  const request = await getSupportRequest(id)
  if (!request) return null
  if (!await getRegionalTenant(request.tenant_id)) return null
  // Support staff may work the shared regional queue. A read-only admin cannot
  // request/start/terminate a session, so callers still enforce role after.
  return request
}

/** Public only in the sense that it still requires an invited admin email. */
router.post('/auth/otp/request', async (req, res) => {
  if (!adminAvailability(res)) return
  const parsed = AdminOtpRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid administrator email' })

  const email = parsed.data.email
  // Do not reveal whether an address is an employee. The code is sent only by
  // Supabase Auth when the account already exists (shouldCreateUser=false).
  const admin = await findPlatformAdminByEmail(email)
  if (!admin || admin.region !== backendAdminRegion() || admin.status === 'suspended') {
    return res.status(200).json({ ok: true })
  }
  const result = await requestAdminOtp(email)
  if (result.error) {
    const status = (result.error as { status?: number }).status
    if (status === 429) return res.status(429).json({ error: 'Too many code requests. Try again shortly.' })
    return res.status(502).json({ error: 'Could not send the administrator code' })
  }
  return res.status(200).json({ ok: true })
})

router.post('/auth/otp/verify', async (req, res) => {
  if (!adminAvailability(res)) return
  const parsed = AdminOtpVerifySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter the 6-digit administrator code' })

  const verified = await verifyAdminOtp(parsed.data.email, parsed.data.otp)
  if (!verified) return res.status(401).json({ error: 'Invalid or expired code' })
  const verifiedUser = verified.user
  const verifiedSession = verified.session
  if (!verifiedUser || !verifiedSession) return res.status(401).json({ error: 'Invalid or expired code' })

  const admin = await findPlatformAdminByUserId(verifiedUser.id)
  if (!admin || admin.region !== backendAdminRegion() || admin.status === 'suspended') {
    return res.status(403).json({ error: 'This account is not an active administrator' })
  }

  let currentAdmin = admin
  if (admin.status === 'invited') {
    currentAdmin = await updatePlatformAdmin(admin.id, { status: 'active', activated_at: new Date().toISOString() })
  }
  const factors = await listAdminFactors(verifiedUser.id)
  await audit(req, 'admin.auth.otp_verified', {
    administratorId: currentAdmin.id,
    targetType: 'platform_admin',
    targetId: currentAdmin.id,
    afterSummary: { aal: 'aal1', hasTotp: factors.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified') },
  })

  res.set('Cache-Control', 'no-store')
  return res.status(200).json({
    admin: publicAdmin(currentAdmin),
    session: { accessToken: verifiedSession.access_token, refreshToken: verifiedSession.refresh_token },
    aal: 'aal1',
    requiresMfaSetup: !factors.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified'),
  })
})

router.post('/auth/logout', allowAdminAal1, async (req, res) => {
  try {
    await signOutAdminToken(req.admin!.token)
  } catch (error) {
    console.error('[admin-auth] logout failed', error)
    return res.status(503).json({ error: 'Could not end the administrator session' })
  }
  await audit(req, 'admin.auth.logout')
  return res.status(204).send()
})

router.get('/auth/context', allowAdminAal1, async (req, res) => {
  const factors = await listAdminFactors(req.admin!.authUserId)
  const hasTotp = factors.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified')
  return res.json({
    admin: {
      id: req.admin!.id,
      email: req.admin!.email,
      displayName: req.admin!.displayName,
      role: req.admin!.role,
      region: req.admin!.region,
      status: req.admin!.status,
    },
    aal: req.admin!.aal,
    factors,
    hasTotp,
    requiresMfaSetup: !hasTotp,
    taxRateBps: adminTaxRateBps(),
  })
})

// All remaining Admin Panel routes require a verified TOTP (aal2). No
// merchant auth middleware is mounted here.
protectedRouter.use(requireAdminAal2)

protectedRouter.get('/overview', async (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
  const tenantIds = await regionalTenantIds()
  const countRegional = (table: string, extra: (query: any) => any) => tenantIds.length === 0
    ? Promise.resolve(0)
    : countAdminRows(table, (query) => extra(query.in('tenant_id', tenantIds)))
  const [activeSubscriptions, expiredSubscriptions, trials, staff, failedEmails, failedImports, failedForecasts] = await Promise.all([
    countRegional('billing_subscriptions', (query) => query.in('status', ['created', 'authenticated', 'active', 'pending', 'halted'])),
    countRegional('billing_subscriptions', (query) => query.in('status', ['cancelled', 'completed', 'expired'])),
    countRegional('billing_trials', (query) => query.eq('status', 'active')),
    countRegional('staff_members', (query) => query.eq('is_active', true)),
    countRegional('email_log', (query) => query.eq('status', 'failed').gte('created_at', since)),
    countRegional('import_batches', (query) => query.eq('status', 'failed').gte('created_at', since)),
    countRegional('forecast_runs', (query) => query.eq('status', 'failed').gte('created_at', since)),
  ])
  await audit(req, 'admin.overview.viewed')
  return res.json({
    region: backendAdminRegion(),
    generatedAt: new Date().toISOString(),
    signups: { totalTenants: tenantIds.length, activeTrials: trials },
    subscriptions: { active: activeSubscriptions, expired: expiredSubscriptions },
    activeMerchantUsers: staff,
    operationalFailures: { windowHours: 24, emails: failedEmails, imports: failedImports, forecasts: failedForecasts },
  })
})

protectedRouter.get('/tenants/recent', async (req, res) => {
  const parsed = AdminListSchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid list pagination' })
  const { limit, cursor } = parsed.data
  const page = await listRegionalTenants(limit, cursor)
  const tenantIds = page.rows.map((tenant) => tenant.id)
  const [staff, subscriptions] = tenantIds.length === 0
    ? [[], []]
    : await Promise.all([
        queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.in('tenant_id', tenantIds)),
        queryAdminRows<Record<string, unknown>>('billing_subscriptions', (query) => query.in('tenant_id', tenantIds).order('updated_at', { ascending: false })),
      ])

  const staffByTenant = new Map<string, { total: number; active: number }>()
  for (const member of staff) {
    if (typeof member.tenant_id !== 'string') continue
    const current = staffByTenant.get(member.tenant_id) ?? { total: 0, active: 0 }
    current.total += 1
    if (member.is_active === true) current.active += 1
    staffByTenant.set(member.tenant_id, current)
  }

  const activeSubscriptionStatuses = new Set(['created', 'authenticated', 'active', 'pending', 'halted'])
  const subscriptionsByTenant = new Map<string, { total: number; active: number; latestStatus: string | null }>()
  for (const subscription of subscriptions) {
    if (typeof subscription.tenant_id !== 'string') continue
    const current = subscriptionsByTenant.get(subscription.tenant_id) ?? { total: 0, active: 0, latestStatus: null }
    current.total += 1
    if (activeSubscriptionStatuses.has(String(subscription.status ?? '').toLowerCase())) current.active += 1
    if (!current.latestStatus) current.latestStatus = typeof subscription.status === 'string' ? subscription.status : null
    subscriptionsByTenant.set(subscription.tenant_id, current)
  }

  await audit(req, 'admin.tenants.recent_viewed', { afterSummary: { resultCount: page.rows.length, offset: cursor, limit } })
  return res.json({
    region: backendAdminRegion(),
    total: page.total,
    cursor,
    limit,
    results: page.rows.map((tenant) => ({
      id: tenant.id,
      businessName: tenant.business_name,
      tradeName: tenant.trade_name ?? null,
      country: tenant.country,
      city: tenant.city,
      createdAt: tenant.created_at,
      userCount: staffByTenant.get(tenant.id)?.total ?? 0,
      activeUserCount: staffByTenant.get(tenant.id)?.active ?? 0,
      subscriptionCount: subscriptionsByTenant.get(tenant.id)?.total ?? 0,
      activeSubscriptionCount: subscriptionsByTenant.get(tenant.id)?.active ?? 0,
      latestSubscriptionStatus: subscriptionsByTenant.get(tenant.id)?.latestStatus ?? null,
    })),
  })
})

protectedRouter.get('/tenants/search', async (req, res) => {
  const parsed = AdminSearchSchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Search must contain at least two characters' })
  const { q, limit, offset } = parsed.data
  const pattern = `%${q}%`
  const [businessMatches, tradeMatches, stores, staffByName, staffByEmail, subscriptions] = await Promise.all([
    queryAdminRows<Record<string, unknown>>('tenants', (query) => query.ilike('business_name', pattern).limit(50)),
    queryAdminRows<Record<string, unknown>>('tenants', (query) => query.ilike('trade_name', pattern).limit(50)),
    queryAdminRows<Record<string, unknown>>('stores', (query) => query.ilike('name', pattern).limit(100)),
    queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.ilike('name', pattern).limit(100)),
    queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.ilike('email', pattern).limit(100)),
    queryAdminRows<Record<string, unknown>>('billing_subscriptions', (query) => query.ilike('provider_subscription_id', pattern).limit(100)),
  ])
  const [subscriptionsByPlan] = await Promise.all([
    queryAdminRows<Record<string, unknown>>('billing_subscriptions', (query) => query.ilike('provider_plan_id', pattern).limit(100)),
  ])
  const ids = new Set<string>()
  for (const row of [...businessMatches, ...tradeMatches, ...stores, ...staffByName, ...staffByEmail, ...subscriptions, ...subscriptionsByPlan]) {
    const tenantId = typeof row.tenant_id === 'string' ? row.tenant_id : typeof row.id === 'string' && (businessMatches.includes(row) || tradeMatches.includes(row)) ? row.id : null
    if (tenantId) ids.add(tenantId)
  }
  if (/^[0-9a-f-]{36}$/i.test(q)) ids.add(q)
  const tenants = ids.size
    ? await queryAdminRows<Record<string, unknown>>('tenants', (query) => query.in('id', [...ids]).limit(100))
    : []
  const filtered = tenants.filter(regionalTenant)
  const sliced = filtered.slice(offset, offset + limit)
  await audit(req, 'admin.tenants.searched', { afterSummary: { resultCount: sliced.length } })
  return res.json({
    query: q,
    region: backendAdminRegion(),
    total: filtered.length,
    results: sliced.map((tenant) => ({
      id: tenant.id,
      businessName: tenant.business_name,
      tradeName: tenant.trade_name ?? null,
      country: tenant.country,
      city: tenant.city,
      createdAt: tenant.created_at,
    })),
  })
})

protectedRouter.get('/tenants/:tenantId', async (req, res) => {
  const parsed = AdminTenantIdSchema.safeParse(req.params)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tenant id' })
  const tenant = await getRegionalTenant(parsed.data.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

  const [stores, staff, subscriptions, transactions, overrides, privateOffers, emailFailures, importFailures, forecastFailures] = await Promise.all([
    queryAdminRows<Record<string, unknown>>('stores', (query) => query.eq('tenant_id', tenant.id).order('created_at', { ascending: true })),
    queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.eq('tenant_id', tenant.id).order('created_at', { ascending: true })),
    queryAdminRows<Record<string, unknown>>('billing_subscriptions', (query) => query.eq('tenant_id', tenant.id).order('updated_at', { ascending: false }).limit(50)),
    queryAdminRows<Record<string, unknown>>('billing_transactions', (query) => query.eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(50)),
    queryAdminRows<Record<string, unknown>>('admin_entitlement_overrides', (query) => query.eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(50)),
    queryAdminRows<Record<string, unknown>>('private_billing_offers', (query) => query.eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(50)),
    queryAdminRows<Record<string, unknown>>('email_log', (query) => query.eq('tenant_id', tenant.id).eq('status', 'failed').order('created_at', { ascending: false }).limit(20)),
    queryAdminRows<Record<string, unknown>>('import_batches', (query) => query.eq('tenant_id', tenant.id).eq('status', 'failed').order('created_at', { ascending: false }).limit(20)),
    queryAdminRows<Record<string, unknown>>('forecast_runs', (query) => query.eq('tenant_id', tenant.id).eq('status', 'failed').order('created_at', { ascending: false }).limit(20)),
  ])
  await audit(req, 'admin.tenant.viewed', { tenantId: String(tenant.id), targetType: 'tenant', targetId: String(tenant.id) })
  return res.json({
    tenant: {
      id: tenant.id,
      businessName: tenant.business_name,
      tradeName: tenant.trade_name ?? null,
      address: { city: tenant.city, state: tenant.state, country: tenant.country, postalCode: tenant.postal_code },
      createdAt: tenant.created_at,
    },
    stores: stores.map((store) => ({ id: store.id, name: store.name, city: store.city, country: store.country, isActive: store.is_active, createdAt: store.created_at })),
    users: staff.map((member) => ({ id: member.id, name: member.name, email: member.email ?? null, role: member.role, isActive: member.is_active, createdAt: member.created_at })),
    subscriptions: subscriptions.map((subscription) => ({
      id: subscription.id,
      provider: subscription.provider,
      providerSubscriptionId: subscription.provider_subscription_id,
      providerPlanId: subscription.provider_plan_id,
      planKey: subscription.plan_key,
      billingCycle: subscription.billing_cycle,
      currency: subscription.currency,
      status: subscription.status,
      entitlementStatus: subscription.entitlement_status,
      currentStartAt: safeDate(String(subscription.current_start_at ?? '')),
      currentEndAt: safeDate(String(subscription.current_end_at ?? '')),
      graceUntilAt: safeDate(String(subscription.grace_until_at ?? '')),
      updatedAt: subscription.updated_at,
    })),
    billingTimeline: transactions.map((transaction) => ({ id: transaction.id, kind: transaction.kind, status: transaction.status, amountMinor: transaction.amount_minor, currency: transaction.currency, createdAt: transaction.created_at })),
    entitlements: overrides.map((override) => ({ id: override.id, entitlementKey: override.entitlement_key, overrideValue: override.override_value, justification: override.justification, ticketId: override.ticket_id, expiresAt: override.expires_at, revokedAt: override.revoked_at })),
    privateOffers: privateOffers.map((offer) => ({ id: offer.id, basePlanKey: offer.base_plan_key, billingCycle: offer.billing_cycle, currency: offer.currency, baseAmountMinor: offer.negotiated_base_amount_minor, taxAmountMinor: offer.tax_amount_minor, totalAmountMinor: offer.total_amount_minor, trialDurationMinutes: Number(offer.trial_duration_minutes ?? 0) > 0 ? Number(offer.trial_duration_minutes) : Number(offer.trial_days ?? 0) * 1440, status: offer.status, latestActivationAt: offer.latest_activation_at, providerMode: offer.provider_mode, providerPlanId: offer.provider_plan_id, createdAt: offer.created_at })),
    operationalFailures: { emails: emailFailures, imports: importFailures, forecasts: forecastFailures },
  })
})

protectedRouter.post('/tenants/:tenantId/invitation/resend', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const parsed = AdminTenantIdSchema.safeParse(req.params)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tenant id' })
  const tenant = await getRegionalTenant(parsed.data.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const owners = await queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.eq('tenant_id', tenant.id).eq('role', 'owner').eq('is_active', true).not('email', 'is', null).limit(1))
  const owner = owners[0]
  if (!owner || typeof owner.email !== 'string') return res.status(409).json({ error: 'No invited merchant owner is available' })
  try {
    await inviteAuthUser(owner.email)
  } catch (error) {
    console.error('[admin] merchant invitation resend failed', error)
    return res.status(502).json({ error: 'Could not resend merchant invitation' })
  }
  await audit(req, 'admin.merchant_invitation.resent', { tenantId: String(tenant.id), targetType: 'staff_member', targetId: String(owner.id) })
  return res.json({ ok: true })
})

protectedRouter.post('/tenants/:tenantId/sessions/revoke', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const parsed = AdminTenantIdSchema.safeParse(req.params)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tenant id' })
  const tenant = await getRegionalTenant(parsed.data.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  await updateAdminRows('staff_sessions', { logged_out_at: new Date().toISOString(), logout_reason: 'interrupted' }, (query) => query.eq('tenant_id', tenant.id).is('logged_out_at', null))
  await audit(req, 'admin.merchant_sessions.revoked', { tenantId: String(tenant.id), targetType: 'tenant', targetId: String(tenant.id) })
  return res.json({ ok: true })
})

protectedRouter.get('/team', requireAdminRole('platform_owner', 'support_admin', 'read_only'), async (_req, res) => {
  const admins = await listPlatformAdmins()
  return res.json({ admins: admins.map(publicAdmin), region: backendAdminRegion() })
})

protectedRouter.post('/team/invite', requireAdminRole('platform_owner'), requireFreshAdminStepUp, async (req, res) => {
  const parsed = AdminInviteSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter an email, display name, and valid admin role' })
  const existing = await findPlatformAdminByEmail(parsed.data.email)
  if (existing && existing.status !== 'suspended') return res.status(409).json({ error: 'That email already has a regional administrator account' })
  let authUser: { id: string; email?: string | null }
  try {
    authUser = await inviteAuthUser(parsed.data.email)
  } catch {
    return res.status(409).json({ error: 'Could not invite this email through regional Supabase Auth' })
  }
  const admin = await createPlatformAdmin({ authUserId: authUser.id, email: parsed.data.email, displayName: parsed.data.displayName, role: parsed.data.role, invitedBy: req.admin!.id })
  await audit(req, 'admin.team.invited', { targetType: 'platform_admin', targetId: admin.id, afterSummary: { role: admin.role, email: admin.email } })
  return res.status(201).json({ admin: publicAdmin(admin) })
})

protectedRouter.post('/team/:adminId/suspend', requireAdminRole('platform_owner'), requireFreshAdminStepUp, async (req, res) => {
  const target = await getPlatformAdmin(routeParam(req, 'adminId'))
  if (!target || target.region !== backendAdminRegion()) return res.status(404).json({ error: 'Administrator not found' })
  if (target.id === req.admin!.id) return res.status(400).json({ error: 'Self-suspension is not allowed' })
  if (target.role === 'platform_owner' && target.status === 'active' && (await countActivePlatformOwners()) <= 2) {
    return res.status(409).json({ error: 'Keep at least two active Platform Owners' })
  }
  const updated = await updatePlatformAdmin(target.id, { status: 'suspended', suspended_at: new Date().toISOString() })
  await audit(req, 'admin.team.suspended', { targetType: 'platform_admin', targetId: updated.id, beforeSummary: { status: target.status }, afterSummary: { status: updated.status } })
  return res.json({ admin: publicAdmin(updated) })
})

protectedRouter.post('/team/:adminId/activate', requireAdminRole('platform_owner'), requireFreshAdminStepUp, async (req, res) => {
  const target = await getPlatformAdmin(routeParam(req, 'adminId'))
  if (!target || target.region !== backendAdminRegion()) return res.status(404).json({ error: 'Administrator not found' })
  const updated = await updatePlatformAdmin(target.id, { status: 'active', suspended_at: null, activated_at: target.activated_at ?? new Date().toISOString() })
  await audit(req, 'admin.team.activated', { targetType: 'platform_admin', targetId: updated.id })
  return res.json({ admin: publicAdmin(updated) })
})

protectedRouter.post('/team/:adminId/mfa/reset', requireAdminRole('platform_owner'), requireFreshAdminStepUp, async (req, res) => {
  const parsed = AdminMfaResetSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Type the target email and a reason' })
  const target = await findPlatformAdminByEmail(parsed.data.targetEmail)
  if (!target || target.id !== routeParam(req, 'adminId') || target.region !== backendAdminRegion()) return res.status(404).json({ error: 'Administrator not found' })
  if (target.id === req.admin!.id || target.auth_user_id === req.admin!.authUserId) return res.status(400).json({ error: 'Self MFA reset is not allowed' })
  if ((await countActivePlatformOwners()) < 2) return res.status(409).json({ error: 'MFA recovery requires at least two active Platform Owners' })
  const factors = await listAdminFactors(target.auth_user_id)
  for (const factor of factors) await deleteAdminFactor(target.auth_user_id, factor.id)
  await audit(req, 'admin.team.mfa_reset', {
    targetType: 'platform_admin',
    targetId: target.id,
    reason: parsed.data.reason,
    beforeSummary: { factorCount: factors.length },
    afterSummary: { factorCount: 0, requiresMfaSetup: true },
  })
  return res.json({ ok: true, requiresMfaSetup: true })
})

protectedRouter.post('/entitlement-overrides', requireAdminRole('platform_owner'), async (req, res) => {
  const parsed = AdminEntitlementOverrideSchema.safeParse(req.body)
  if (!parsed.success || !boundedExpiry(parsed.data.expiresAt)) return res.status(400).json({ error: 'Use a bounded expiry within 30 days' })
  const tenant = await getRegionalTenant(parsed.data.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const override = await insertEntitlementOverride({
    tenantId: parsed.data.tenantId,
    entitlementKey: parsed.data.entitlementKey,
    overrideValue: parsed.data.overrideValue,
    justification: parsed.data.justification,
    ticketId: parsed.data.ticketId,
    createdBy: req.admin!.id,
    expiresAt: parsed.data.expiresAt.toISOString(),
  })
  await audit(req, 'admin.entitlement_override.created', { tenantId: parsed.data.tenantId, targetType: 'entitlement_override', targetId: String((override as { id: string }).id), ticketId: parsed.data.ticketId, reason: parsed.data.justification, afterSummary: { entitlementKey: parsed.data.entitlementKey, overrideValue: parsed.data.overrideValue, expiresAt: parsed.data.expiresAt.toISOString() } })
  return res.status(201).json({ override })
})

protectedRouter.post('/private-billing-offers', requireAdminRole('platform_owner'), requireFreshAdminStepUp, async (req, res) => {
  const parsed = AdminPrivateOfferSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid private billing offer', details: parsed.error.flatten() })
  const input = parsed.data
  const tenant = await getRegionalTenant(input.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  if (input.latestActivationAt.getTime() <= Date.now()) return res.status(400).json({ error: 'Latest activation must be in the future' })

  const region = backendAdminRegion()
  const currency = region === 'IN' ? 'INR' : 'USD'
  const taxRateBps = adminTaxRateBps()
  const taxAmountMinor = Math.round(input.negotiatedBaseAmountMinor * taxRateBps / 10_000)
  const totalAmountMinor = input.negotiatedBaseAmountMinor + taxAmountMinor
  const client = privilegedSupabase()
  const inserted = await client.from('private_billing_offers').insert({
    tenant_id: input.tenantId,
    region,
    base_plan_key: input.basePlanKey,
    billing_cycle: input.billingCycle,
    currency,
    negotiated_base_amount_minor: input.negotiatedBaseAmountMinor,
    tax_rate_bps: taxRateBps,
    tax_amount_minor: taxAmountMinor,
    total_amount_minor: totalAmountMinor,
    included_location_count: input.includedLocations,
    included_register_count: input.includedRegisters,
    included_user_count: input.includedUsers,
    additional_location_unit_amount_minor: input.additionalLocationUnitAmountMinor,
    additional_register_unit_amount_minor: input.additionalRegisterUnitAmountMinor,
    additional_user_unit_amount_minor: input.additionalUserUnitAmountMinor,
    trial_days: Math.ceil(input.trialDurationMinutes / 1440),
    trial_duration_minutes: input.trialDurationMinutes,
    latest_activation_at: input.latestActivationAt.toISOString(),
    price_validity: input.priceValidity,
    fixed_billing_cycles: input.fixedBillingCycles,
    provider_mode: getBillingMode(),
    status: 'provisioning',
    internal_reason: input.internalReason,
    sales_reference: input.salesReference ?? null,
    created_by: req.admin!.id,
  }).select('*').single()
  if (inserted.error || !inserted.data) return res.status(500).json({ error: 'Could not record the private offer' })

  const offer = inserted.data as Record<string, unknown>
  let providerPlan
  try {
    providerPlan = await createRazorpayPlan({
      amountMinor: totalAmountMinor,
      currency,
      billingCycle: input.billingCycle,
      name: `Ambel ${input.basePlanKey} private offer`,
      description: `Private ${input.billingCycle} offer ${String(offer.id)}`,
    })
  } catch (error) {
    await client.from('private_billing_offers').update({ status: 'provisioning_failed', updated_at: new Date().toISOString() }).eq('id', offer.id)
    await audit(req, 'admin.private_billing_offer.provisioning_failed', {
      tenantId: input.tenantId, targetType: 'private_billing_offer', targetId: String(offer.id), reason: input.internalReason,
      afterSummary: { providerStatus: error instanceof RazorpayRequestError ? error.providerStatus : null },
    })
    return res.status(502).json({ error: 'Razorpay could not create the private Plan. No offer was shown to the owner.' })
  }

  const completed = await client.from('private_billing_offers').update({
    provider_plan_id: providerPlan.id,
    status: 'offered',
    updated_at: new Date().toISOString(),
  }).eq('id', offer.id).eq('status', 'provisioning').select('*').single()
  if (completed.error || !completed.data) return res.status(500).json({ error: 'The Razorpay Plan was created but the offer could not be activated. Contact engineering with the audit ID.' })

  if (input.trialDurationMinutes > 0) {
    const baseSnapshot = snapshotForPlan(region, input.basePlanKey)
    const entitlementSnapshot = {
      ...baseSnapshot,
      planKey: input.basePlanKey,
      limits: {
        ...baseSnapshot.limits,
        maxLocations: input.includedLocations,
        maxActiveRegisters: input.includedRegisters,
        maxActiveUsers: input.includedUsers,
      },
    }
    const trial = await client.from('billing_trials').insert({
      tenant_id: input.tenantId,
      private_offer_id: offer.id,
      region,
      plan_key: input.basePlanKey,
      entitlement_snapshot: entitlementSnapshot,
      status: 'pending',
      started_at: input.latestActivationAt.toISOString(),
      latest_activation_at: input.latestActivationAt.toISOString(),
    })
    if (trial.error) return res.status(409).json({ error: 'Offer created, but this business already has an open trial. Close it before assigning another trial.' })
  }

  await audit(req, 'admin.private_billing_offer.created', {
    tenantId: input.tenantId,
    targetType: 'private_billing_offer',
    targetId: String(offer.id),
    reason: input.internalReason,
    afterSummary: { basePlanKey: input.basePlanKey, billingCycle: input.billingCycle, currency, negotiatedBaseAmountMinor: input.negotiatedBaseAmountMinor, taxAmountMinor, totalAmountMinor, trialDurationMinutes: input.trialDurationMinutes },
  })
  return res.status(201).json({ offer: completed.data })
})

protectedRouter.post('/entitlement-overrides/:overrideId/revoke', requireAdminRole('platform_owner'), async (req, res) => {
  const parsed = AdminRevokeOverrideSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'A revocation reason is required' })
  const rows = await queryAdminRows<Record<string, unknown>>('admin_entitlement_overrides', (query) => query.eq('id', req.params.overrideId).is('revoked_at', null).limit(1))
  if (!rows[0]) return res.status(404).json({ error: 'Override not found or already revoked' })
  const overrideId = routeParam(req, 'overrideId')
  if (typeof rows[0].tenant_id !== 'string' || !await getRegionalTenant(rows[0].tenant_id)) return res.status(404).json({ error: 'Override not found or already revoked' })
  const updated = await revokeEntitlementOverride(overrideId, req.admin!.id, parsed.data.reason)
  await audit(req, 'admin.entitlement_override.revoked', { tenantId: String(rows[0].tenant_id), targetType: 'entitlement_override', targetId: overrideId, reason: parsed.data.reason, beforeSummary: { revokedAt: null }, afterSummary: { revokedAt: (updated as { revoked_at: string }).revoked_at } })
  return res.json({ override: updated })
})

protectedRouter.post('/operations/retry', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const parsed = AdminRetrySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'A supported operation id and idempotency key are required' })
  const { operationKind, operationId, idempotencyKey } = parsed.data
  const expected = `${operationKind}:${operationId}`
  if (idempotencyKey !== expected) return res.status(400).json({ error: 'Retry requires the operation’s established idempotency key' })
  const operation = await operationExists(operationKind, operationId)
  if (!operation) return res.status(404).json({ error: 'Operation not found' })
  if (typeof operation.tenant_id === 'string' && !await getRegionalTenant(operation.tenant_id)) return res.status(404).json({ error: 'Operation not found' })
  if (operationKind === 'webhook' && operation.processed_at) return res.status(409).json({ error: 'Webhook is already processed' })
  if (operationKind !== 'webhook' && !['failed', 'queued', 'running'].includes(String(operation.status ?? ''))) return res.status(409).json({ error: 'This operation is not retryable' })
  const existingRetry = await queryAdminSingle<Record<string, unknown>>('admin_operation_retries', (query) => query.eq('operation_kind', operationKind).eq('idempotency_key', idempotencyKey))
  if (existingRetry) return res.status(200).json({ retry: existingRetry, idempotent: true })
  let retry: unknown
  try {
    retry = await insertOperationRetry({ operationKind, operationId, idempotencyKey, requestedBy: req.admin!.id, status: 'queued' })
  } catch (error) {
    // Two operator tabs can race the unique idempotency key. Return the
    // already-created ledger row rather than turning a safe retry into a 500.
    const raced = await queryAdminSingle<Record<string, unknown>>('admin_operation_retries', (query) => query.eq('operation_kind', operationKind).eq('idempotency_key', idempotencyKey))
    if (!raced) throw error
    return res.status(200).json({ retry: raced, idempotent: true })
  }
  await audit(req, 'admin.operation.retry_requested', { targetType: operationKind, targetId: operationId, afterSummary: { idempotencyKey, status: 'queued' } })
  return res.status(202).json({ retry })
})

protectedRouter.post('/support/requests', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const parsed = AdminSupportRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Tenant, ticket id, and reason are required' })
  const tenant = await getRegionalTenant(parsed.data.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const owners = await queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.eq('tenant_id', tenant.id).eq('role', 'owner').eq('is_active', true).not('user_id', 'is', null).limit(1))
  const owner = owners[0]
  if (!owner) return res.status(409).json({ error: 'This tenant has no active merchant Owner to approve access' })
  const request = await insertSupportRequest({ tenantId: parsed.data.tenantId, merchantOwnerId: String(owner.id), requestedBy: req.admin!.id, ticketId: parsed.data.ticketId, reason: parsed.data.reason })
  await audit(req, 'admin.support_request.created', { tenantId: parsed.data.tenantId, targetType: 'support_access_request', targetId: request.id, ticketId: request.ticket_id, reason: request.reason, afterSummary: { status: request.status } })
  return res.status(201).json({ request: { id: request.id, tenantId: request.tenant_id, ticketId: request.ticket_id, reason: request.reason, status: request.status, createdAt: request.created_at } })
})

protectedRouter.get('/support/requests', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const parsed = AdminListSchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid pagination' })
  const requests = await listSupportRequests(parsed.data.limit)
  const regionalRequests = (await Promise.all(
    requests.map(async (request) => (await getRegionalTenant(request.tenant_id) ? request : null)),
  )).filter((request): request is NonNullable<typeof request> => Boolean(request))
  return res.json({ requests: regionalRequests.map((request) => ({ id: request.id, tenantId: request.tenant_id, ticketId: request.ticket_id, reason: request.reason, status: request.status, approvedAt: request.approved_at, expiresAt: request.expires_at, createdAt: request.created_at })) })
})

protectedRouter.get('/support/requests/:requestId', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const request = await supportRequestForAdmin(req, routeParam(req, 'requestId'))
  if (!request) return res.status(404).json({ error: 'Support request not found' })
  return res.json({ request })
})

protectedRouter.post('/support/requests/:requestId/start', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const request = await supportRequestForAdmin(req, routeParam(req, 'requestId'))
  if (!request) return res.status(404).json({ error: 'Support request not found' })
  if (request.status !== 'approved' || !request.expires_at || new Date(request.expires_at).getTime() <= Date.now()) return res.status(409).json({ error: 'Merchant consent is missing or expired' })
  const token = jwt.sign({ kind: 'ambel_support', requestId: request.id, adminId: req.admin!.id, region: backendAdminRegion() }, supportSessionSecret(), { expiresIn: Math.max(1, Math.floor((new Date(request.expires_at).getTime() - Date.now()) / 1_000)), subject: request.id })
  await updateSupportRequest(request.id, { session_token_hash: hashSupportToken(token) })
  await audit(req, 'admin.support_session.started', { tenantId: request.tenant_id, targetType: 'support_access_request', targetId: request.id, ticketId: request.ticket_id, reason: request.reason, afterSummary: { expiresAt: request.expires_at } })
  return res.json({ sessionToken: token, expiresAt: request.expires_at, requestId: request.id })
})

protectedRouter.post('/support/requests/:requestId/terminate', requireAdminRole('platform_owner', 'support_admin'), async (req, res) => {
  const request = await supportRequestForAdmin(req, routeParam(req, 'requestId'))
  if (!request) return res.status(404).json({ error: 'Support request not found' })
  if (request.status !== 'approved') return res.status(409).json({ error: 'Support session is not active' })
  const updated = await updateSupportRequest(request.id, { status: 'terminated', terminated_at: new Date().toISOString(), terminated_by: req.admin!.id, session_token_hash: null })
  await audit(req, 'admin.support_session.terminated', { tenantId: request.tenant_id, targetType: 'support_access_request', targetId: request.id, ticketId: request.ticket_id })
  return res.json({ request: updated })
})

protectedRouter.get('/audit', requireAdminRole('platform_owner', 'support_admin', 'read_only'), async (req, res) => {
  const parsed = AdminAuditQuerySchema.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid audit pagination' })
  const wantsExport = String(req.query.format ?? '').toLowerCase() === 'csv'
  if (wantsExport && req.admin!.role === 'support_admin') return res.status(403).json({ error: 'Audit export is restricted to Platform Owners and Read-only administrators' })
  const events = await queryAdminRows<Record<string, unknown>>('admin_audit_events', (query) => {
    let scoped = query.order('created_at', { ascending: false }).range(parsed.data.offset, parsed.data.offset + parsed.data.limit - 1)
    if (parsed.data.action) scoped = scoped.eq('action', parsed.data.action)
    if (parsed.data.tenantId) scoped = scoped.eq('tenant_id', parsed.data.tenantId)
    return scoped
  })
  await audit(req, 'admin.audit.viewed', { afterSummary: { count: events.length, export: wantsExport } })
  if (wantsExport) {
    const header = 'created_at,action,administrator_id,target_type,target_id,tenant_id,ticket_id,reason\n'
    const csv = header + events.map((event) => [event.created_at, event.action, event.administrator_id, event.target_type, event.target_id, event.tenant_id, event.ticket_id, event.reason].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="ambel-admin-audit.csv"')
    return res.send(csv)
  }
  return res.json({ events })
})

router.use(protectedRouter)

/**
 * Support-session bearer tokens are intentionally not Supabase JWTs. This
 * middleware only accepts a token minted after merchant consent and permits
 * GET/HEAD/OPTIONS; POST/PUT/PATCH/DELETE are rejected before routing.
 */
export async function supportSessionMiddleware(req: Request, res: Response, next: (error?: unknown) => void) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(405).json({ error: 'Support sessions are read-only' })
  const token = req.get('x-support-session')
  if (!token) return res.status(401).json({ error: 'Support session required' })
  let claims: { kind?: string; requestId?: string; adminId?: string; region?: string }
  try {
    claims = jwt.verify(token, supportSessionSecret()) as typeof claims
  } catch {
    return res.status(401).json({ error: 'Support session expired' })
  }
  if (claims.kind !== 'ambel_support' || !claims.requestId || !claims.adminId || claims.region !== backendAdminRegion()) return res.status(403).json({ error: 'Invalid regional support session' })
  const [request, admin] = await Promise.all([getSupportRequest(claims.requestId), getPlatformAdmin(claims.adminId)])
  if (!request || !admin || admin.status !== 'active' || admin.region !== backendAdminRegion()) return res.status(403).json({ error: 'Support session is no longer active' })
  if (!await getRegionalTenant(request.tenant_id)) return res.status(403).json({ error: 'Support session is not valid for this region' })
  if (request.status !== 'approved' || !request.expires_at || new Date(request.expires_at).getTime() <= Date.now()) {
    if (request.status === 'approved') await updateSupportRequest(request.id, { status: 'expired', session_token_hash: null })
    return res.status(403).json({ error: 'Support session expired' })
  }
  if (request.session_token_hash !== hashSupportToken(token)) return res.status(403).json({ error: 'Support session was terminated' })
  req.supportSession = { requestId: request.id, adminId: admin.id, tenantId: request.tenant_id, expiresAt: request.expires_at }
  next()
}

const supportReadOnlyRouter = Router()
supportReadOnlyRouter.use(supportSessionMiddleware)

async function supportRead(req: Request, action: string, targetType: string, targetId: string | null = null) {
  await insertAuditEvent({ administratorId: req.supportSession!.adminId, action, tenantId: req.supportSession!.tenantId, targetType, targetId, ...requestMetadata(req) })
}

supportReadOnlyRouter.get('/:requestId/tenant', async (req, res) => {
  if (req.params.requestId !== req.supportSession!.requestId) return res.status(403).json({ error: 'Support session mismatch' })
  const tenant = await getRegionalTenant(req.supportSession!.tenantId)
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
  const stores = await queryAdminRows<Record<string, unknown>>('stores', (query) => query.eq('tenant_id', tenant.id).eq('is_active', true).order('name', { ascending: true }))
  const staff = await queryAdminRows<Record<string, unknown>>('staff_members', (query) => query.eq('tenant_id', tenant.id).eq('is_active', true).order('name', { ascending: true }))
  await supportRead(req, 'admin.support_screen.viewed', 'tenant', String(tenant.id))
  return res.json({
    tenant: { id: tenant.id, businessName: tenant.business_name, tradeName: tenant.trade_name ?? null, city: tenant.city, state: tenant.state, country: tenant.country },
    stores: stores.map((store) => ({ id: store.id, name: store.name, city: store.city, isActive: store.is_active })),
    users: staff.map((member) => ({ id: member.id, name: member.name, role: member.role, isActive: member.is_active })),
    readOnly: true,
    expiresAt: req.supportSession!.expiresAt,
  })
})

supportReadOnlyRouter.get('/:requestId/catalog', async (req, res) => {
  if (req.params.requestId !== req.supportSession!.requestId) return res.status(403).json({ error: 'Support session mismatch' })
  const products = await queryAdminRows<Record<string, unknown>>('products', (query) => query.eq('tenant_id', req.supportSession!.tenantId).order('name', { ascending: true }).limit(500))
  const variants = await queryAdminRows<Record<string, unknown>>('variants', (query) => query.eq('tenant_id', req.supportSession!.tenantId).order('created_at', { ascending: true }).limit(1_000))
  await supportRead(req, 'admin.support_screen.catalog_viewed', 'tenant', req.supportSession!.tenantId)
  return res.json({ products: products.map((product) => ({ id: product.id, name: product.name, categoryId: product.category_id })), variants: variants.map((variant) => ({ id: variant.id, productId: variant.product_id, sku: variant.sku, size: variant.size, color: variant.color, price: variant.price })) })
})

supportReadOnlyRouter.get('/:requestId/sales', async (req, res) => {
  if (req.params.requestId !== req.supportSession!.requestId) return res.status(403).json({ error: 'Support session mismatch' })
  const sales = await queryAdminRows<Record<string, unknown>>('sales', (query) => query.eq('tenant_id', req.supportSession!.tenantId).order('created_at', { ascending: false }).limit(100))
  await supportRead(req, 'admin.support_screen.sales_viewed', 'tenant', req.supportSession!.tenantId)
  return res.json({ sales: sales.map((sale) => ({ id: sale.id, totalAmount: sale.total_amount, status: sale.status, source: sale.source, createdAt: sale.created_at })) })
})

// Mounted by routes/index.ts under /api/admin. The second router is exported
// separately so the read-only support token cannot accidentally inherit an
// admin write route.
export { supportReadOnlyRouter }
export default router
