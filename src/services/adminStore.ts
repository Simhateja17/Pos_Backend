import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type AdminRegion = 'IN' | 'INTL'
export type PlatformAdminRole = 'platform_owner' | 'support_admin' | 'read_only'
export type PlatformAdminStatus = 'invited' | 'active' | 'suspended'

export type PlatformAdmin = {
  id: string
  auth_user_id: string
  email: string
  display_name: string
  role: PlatformAdminRole
  region: AdminRegion
  status: PlatformAdminStatus
  invited_by: string | null
  invited_at: string
  activated_at: string | null
  suspended_at: string | null
  created_at: string
  updated_at: string
}

export type AdminAuditInput = {
  administratorId?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  tenantId?: string | null
  ticketId?: string | null
  reason?: string | null
  requestId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  beforeSummary?: unknown
  afterSummary?: unknown
}

export type SupportAccessRequest = {
  id: string
  tenant_id: string
  merchant_owner_id: string
  requested_by: string
  ticket_id: string
  reason: string
  status: 'requested' | 'approved' | 'denied' | 'expired' | 'terminated'
  approved_at: string | null
  expires_at: string | null
  terminated_at: string | null
  terminated_by: string | null
  session_token_hash: string | null
  created_at: string
  updated_at: string
}

let privilegedClient: { key: string; client: SupabaseClient } | null = null

/**
 * Region is deployment configuration, never request input. Production is
 * intentionally fail-closed when the operator forgot to set it.
 */
export function backendAdminRegion(): AdminRegion {
  const configured = (process.env.ADMIN_REGION ?? process.env.BACKEND_REGION ?? '').trim().toUpperCase()
  if (configured === 'IN' || configured === 'INTL') return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_REGION must be IN or INTL in production')
  }
  return 'INTL'
}

export function adminPanelEnabled(): boolean {
  const configured = process.env.ADMIN_PANEL_ENABLED?.trim().toLowerCase()
  if (configured === 'false' || configured === '0' || configured === 'off') return false
  if (process.env.NODE_ENV === 'production') return configured === 'true' || configured === '1' || configured === 'on'
  return true
}

function requireConfig(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the Admin Panel`) 
  return value
}

/** The only adapter allowed to read/write platform-admin tables. */
export function privilegedSupabase(): SupabaseClient {
  const url = requireConfig('SUPABASE_URL')
  const key = requireConfig('SUPABASE_SERVICE_ROLE_KEY')
  const cacheKey = `${url}\n${key}`
  if (privilegedClient?.key === cacheKey) return privilegedClient.client

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  privilegedClient = { key: cacheKey, client }
  return client
}

export function anonymousSupabase(): SupabaseClient {
  const url = requireConfig('SUPABASE_URL')
  const key = requireConfig('SUPABASE_ANON_KEY')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function throwDbError(operation: string, error: unknown): never {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
  throw new Error(`Admin store ${operation} failed: ${message}`)
}

async function single<T>(operation: string, request: PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  const result = await request
  if (result.error) throwDbError(operation, result.error)
  return result.data
}

async function rows<T>(operation: string, request: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const result = await request
  if (result.error) throwDbError(operation, result.error)
  return result.data ?? []
}

export async function findPlatformAdminByUserId(userId: string): Promise<PlatformAdmin | null> {
  const client = privilegedSupabase()
  return single<PlatformAdmin>('find admin by user', client.from('platform_admins').select('*').eq('auth_user_id', userId).maybeSingle())
}

export async function findPlatformAdminByEmail(email: string): Promise<PlatformAdmin | null> {
  const client = privilegedSupabase()
  return single<PlatformAdmin>('find admin by email', client.from('platform_admins').select('*').ilike('email', email.trim()).order('created_at', { ascending: false }).limit(1).maybeSingle())
}

export async function getPlatformAdmin(id: string): Promise<PlatformAdmin | null> {
  const client = privilegedSupabase()
  return single<PlatformAdmin>('get admin', client.from('platform_admins').select('*').eq('id', id).maybeSingle())
}

export async function listPlatformAdmins(): Promise<PlatformAdmin[]> {
  const client = privilegedSupabase()
  return rows<PlatformAdmin>('list admins', client.from('platform_admins').select('*').eq('region', backendAdminRegion()).order('created_at', { ascending: false }))
}

export async function countActivePlatformOwners(): Promise<number> {
  const client = privilegedSupabase()
  const result = await client.from('platform_admins').select('id', { count: 'exact', head: true })
    .eq('region', backendAdminRegion()).eq('role', 'platform_owner').eq('status', 'active')
  if (result.error) throwDbError('count active owners', result.error)
  return result.count ?? 0
}

export async function createPlatformAdmin(input: {
  authUserId: string
  email: string
  displayName: string
  role: PlatformAdminRole
  invitedBy?: string | null
}): Promise<PlatformAdmin> {
  const client = privilegedSupabase()
  const data = await single<PlatformAdmin>('create admin', client.from('platform_admins').insert({
    auth_user_id: input.authUserId,
    email: input.email.trim().toLowerCase(),
    display_name: input.displayName.trim(),
    role: input.role,
    region: backendAdminRegion(),
    status: 'invited',
    invited_by: input.invitedBy ?? null,
  }).select('*').single())
  if (!data) throw new Error('Admin store create admin returned no row')
  return data
}

export async function updatePlatformAdmin(id: string, patch: Partial<Pick<PlatformAdmin, 'status' | 'display_name' | 'role' | 'activated_at' | 'suspended_at'>>): Promise<PlatformAdmin> {
  const client = privilegedSupabase()
  const data = await single<PlatformAdmin>('update admin', client.from('platform_admins').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('region', backendAdminRegion()).select('*').single())
  if (!data) throw new Error('Admin store update admin returned no row')
  return data
}

export async function listAdminFactors(userId: string): Promise<Array<{ id: string; factor_type: string; status: string; friendly_name?: string | null; created_at?: string }>> {
  const result = await privilegedSupabase().auth.admin.mfa.listFactors({ userId })
  if (result.error) throwDbError('list MFA factors', result.error)
  return (result.data?.factors ?? []).map((factor) => ({
    id: factor.id,
    factor_type: factor.factor_type,
    status: factor.status,
    friendly_name: factor.friendly_name,
    created_at: factor.created_at,
  }))
}

export async function deleteAdminFactor(userId: string, factorId: string): Promise<void> {
  const result = await privilegedSupabase().auth.admin.mfa.deleteFactor({ userId, id: factorId })
  if (result.error) throwDbError('delete MFA factor', result.error)
}

export async function inviteAuthUser(email: string): Promise<{ id: string; email?: string | null }> {
  const redirectTo = process.env.ADMIN_INVITE_REDIRECT_URL ?? process.env.INVITE_REDIRECT_URL
  const result = await privilegedSupabase().auth.admin.inviteUserByEmail(email.trim().toLowerCase(), redirectTo ? { redirectTo } : undefined)
  if (result.error || !result.data.user) throwDbError('invite auth user', result.error ?? new Error('Supabase returned no user'))
  return { id: result.data.user.id, email: result.data.user.email }
}

export async function verifyAdminOtp(email: string, otp: string) {
  const result = await anonymousSupabase().auth.verifyOtp({ email: email.trim().toLowerCase(), token: otp, type: 'email' })
  if (result.error || !result.data.session || !result.data.user) return null
  return result.data
}

export async function requestAdminOtp(email: string): Promise<{ error: unknown | null }> {
  const result = await anonymousSupabase().auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: false },
  })
  return { error: result.error }
}

export async function signOutAdminToken(token: string): Promise<void> {
  const result = await privilegedSupabase().auth.admin.signOut(token, 'global')
  if (result.error) throwDbError('sign out admin', result.error)
}

export async function insertAuditEvent(input: AdminAuditInput): Promise<void> {
  const client = privilegedSupabase()
  const result = await client.from('admin_audit_events').insert({
    administrator_id: input.administratorId ?? null,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    tenant_id: input.tenantId ?? null,
    ticket_id: input.ticketId ?? null,
    reason: input.reason ?? null,
    request_id: input.requestId ?? null,
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
    before_summary: input.beforeSummary ?? null,
    after_summary: input.afterSummary ?? null,
  })
  if (result.error) throwDbError('insert audit event', result.error)
}

export async function insertSupportRequest(input: {
  tenantId: string
  merchantOwnerId: string
  requestedBy: string
  ticketId: string
  reason: string
}): Promise<SupportAccessRequest> {
  const data = await single<SupportAccessRequest>('create support request', privilegedSupabase().from('support_access_requests').insert({
    tenant_id: input.tenantId,
    merchant_owner_id: input.merchantOwnerId,
    requested_by: input.requestedBy,
    ticket_id: input.ticketId,
    reason: input.reason,
    status: 'requested',
  }).select('*').single())
  if (!data) throw new Error('Admin store create support request returned no row')
  return data
}

export async function getSupportRequest(id: string): Promise<SupportAccessRequest | null> {
  return single<SupportAccessRequest>('get support request', privilegedSupabase().from('support_access_requests').select('*').eq('id', id).maybeSingle())
}

export async function listSupportRequests(limit = 50): Promise<SupportAccessRequest[]> {
  return rows<SupportAccessRequest>('list support requests', privilegedSupabase().from('support_access_requests').select('*').order('created_at', { ascending: false }).limit(limit))
}

export async function updateSupportRequest(id: string, patch: Partial<SupportAccessRequest>): Promise<SupportAccessRequest> {
  const data = await single<SupportAccessRequest>('update support request', privilegedSupabase().from('support_access_requests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*').single())
  if (!data) throw new Error('Admin store update support request returned no row')
  return data
}

export async function insertEntitlementOverride(input: {
  tenantId: string
  entitlementKey: string
  overrideValue: unknown
  justification: string
  ticketId: string
  createdBy: string
  expiresAt: string
}) {
  const data = await single('create entitlement override', privilegedSupabase().from('admin_entitlement_overrides').insert({
    tenant_id: input.tenantId,
    entitlement_key: input.entitlementKey,
    override_value: input.overrideValue,
    justification: input.justification,
    ticket_id: input.ticketId,
    created_by: input.createdBy,
    expires_at: input.expiresAt,
  }).select('*').single())
  if (!data) throw new Error('Admin store create entitlement override returned no row')
  return data
}

export async function revokeEntitlementOverride(id: string, revokedBy: string, reason: string) {
  const data = await single('revoke entitlement override', privilegedSupabase().from('admin_entitlement_overrides').update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy, revocation_reason: reason }).eq('id', id).is('revoked_at', null).select('*').single())
  if (!data) throw new Error('Entitlement override was already revoked or does not exist')
  return data
}

export async function insertOperationRetry(input: {
  operationKind: 'webhook' | 'email' | 'import' | 'forecast'
  operationId: string
  idempotencyKey: string
  requestedBy: string
  status?: 'queued' | 'replayed' | 'rejected'
  resultSummary?: unknown
}) {
  const data = await single('record operation retry', privilegedSupabase().from('admin_operation_retries').insert({
    operation_kind: input.operationKind,
    operation_id: input.operationId,
    idempotency_key: input.idempotencyKey,
    requested_by: input.requestedBy,
    status: input.status ?? 'queued',
    result_summary: input.resultSummary ?? null,
  }).select('*').single())
  if (!data) throw new Error('Admin store record retry returned no row')
  return data
}

export async function queryAdminRows<T = Record<string, unknown>>(table: string, builder: (query: any) => any): Promise<T[]> {
  // Table names are selected only from server-owned allowlists in routes; this
  // helper is not exported to browser code and never interpolates user input.
  const query = builder(privilegedSupabase().from(table).select('*'))
  return rows<T>(`query ${table}`, query)
}

export async function queryAdminSingle<T = Record<string, unknown>>(table: string, builder: (query: any) => any): Promise<T | null> {
  const query = builder(privilegedSupabase().from(table).select('*')).maybeSingle()
  return single<T>(`query ${table}`, query)
}

export async function countAdminRows(table: string, builder?: (query: any) => any): Promise<number> {
  const base = privilegedSupabase().from(table).select('id', { count: 'exact', head: true })
  const result = builder ? await builder(base) : await base
  if (result.error) throwDbError(`count ${table}`, result.error)
  return result.count ?? 0
}

export type AdminTenantListRow = {
  id: string
  business_name: string
  trade_name: string | null
  country: string | null
  city: string | null
  created_at: string
}

/**
 * Return a bounded, newest-first tenant page for the configured region. The
 * database itself is already regional; the country predicate is a second
 * server-side guard that mirrors the tenant-detail boundary in admin routes.
 */
export async function listRegionalTenants(limit = 20, offset = 0): Promise<{ rows: AdminTenantListRow[]; total: number }> {
  const client = privilegedSupabase()
  let query = client.from('tenants')
    .select('id,business_name,trade_name,country,city,created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  query = backendAdminRegion() === 'IN'
    ? query.eq('country', 'IN')
    : query.not('country', 'ilike', 'IN')

  const result = await query
  if (result.error) throwDbError('list regional tenants', result.error)
  return {
    rows: (result.data ?? []) as AdminTenantListRow[],
    total: result.count ?? 0,
  }
}

export async function updateAdminRows(table: string, patch: Record<string, unknown>, builder: (query: any) => any): Promise<number> {
  const result = await builder(privilegedSupabase().from(table).update(patch))
  if (result.error) throwDbError(`update ${table}`, result.error)
  return result.count ?? 0
}

export async function insertAdminRow(table: string, payload: Record<string, unknown>): Promise<void> {
  const result = await privilegedSupabase().from(table).insert(payload)
  if (result.error) throwDbError(`insert ${table}`, result.error)
}
