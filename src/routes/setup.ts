import { Router, type Request } from 'express'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { activeStoreId } from '../middleware/storeContext'
import { effectiveRole, requireRole } from '../middleware/requireRole'
import { getCounterDeviceToken, hashCounterDeviceToken } from '../lib/counterDevice'
import { findExactVariant } from '../services/catalogLookup'
import {
  ScannerTestRequestSchema,
  SetupResolutionSchema,
  TourProgressRequestSchema,
  type SetupResolution,
} from '../contracts/schemas/setup'

const router = Router()

type SetupChoice = 'verified' | 'no_scanner' | 'configure_later'
type TeamMode = 'staffed' | 'solo_owner'
type StepStatus = 'complete' | 'incomplete' | 'blocked' | 'unavailable'

type SetupFacts = {
  tenant: any
  store: any
  progress: any | null
  tour: any | null
  ownerOrManagerPinReady: boolean
  staffReady: boolean
  productReady: boolean
  counterReady: boolean
  devicePaired: boolean
}

function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : null
}

function taxIdentityValid(tenant: any): boolean {
  // The selected store owns the trading address. The tenant contributes only
  // the legal identity and GST decision here; requiring the tenant's legacy
  // registered-address columns would reopen setup for stores whose address is
  // already complete in `stores`.
  if (!present(tenant.business_name)) return false
  if (tenant.gst_status === 'unregistered') return true
  if (tenant.gst_status === 'regular' || tenant.gst_status === 'composition') {
    return present(tenant.tax_id)
  }
  // Signup keeps GST optional. A missing status is therefore an unresolved
  // setup fact, not proof that the business is unregistered.
  return false
}

function storeProfileValid(store: any): boolean {
  return Boolean(
    present(store.name) &&
      present(store.address_line1) &&
      present(store.city) &&
      present(store.state) &&
      present(store.postal_code),
  )
}

function tourJson(row: any | null) {
  const seen = Array.isArray(row?.seen_steps)
    ? row.seen_steps.filter((value: unknown): value is string => typeof value === 'string')
    : []
  return {
    status: row?.status ?? 'not_started',
    lastStep: row?.last_step ?? null,
    seenSteps: seen,
    startedAt: iso(row?.started_at),
    skippedAt: iso(row?.skipped_at),
    completedAt: iso(row?.completed_at),
  }
}

function activeRole(req: Request): 'owner' | 'manager' {
  const role = effectiveRole(req)
  return role === 'owner' || role === 'manager' ? role : 'manager'
}

function step(
  id: string,
  title: string,
  description: string,
  status: StepStatus,
  required: boolean,
  billingBlocking: boolean,
  dependsOn: string[],
  actionHref: string | null,
  reason: string | null,
) {
  return {
    id,
    title,
    description,
    status,
    complete: status === 'complete',
    required,
    // These two steps are resolved by an explicit "solo"/"later" choice;
    // the rest require a real operational record before setup is complete.
    skippable: id === 'team' || id === 'scanner',
    billingBlocking,
    dependsOn,
    actionHref,
    reason,
  }
}

async function actingStaffId(req: Request, tx: any): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  const row = await tx.staff_members.findFirst({
    where: { user_id: req.user!.id, is_active: true },
    select: { id: true },
  })
  return row?.id ?? null
}

async function readFacts(req: Request, storeId: string): Promise<SetupFacts | null> {
  const token = getCounterDeviceToken(req)
  const deviceHash = token ? hashCounterDeviceToken(token) : null

  return forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const tenant = await tx.tenants.findFirst({
      where: { id: req.user!.tenantId },
      select: {
        id: true,
        business_name: true,
        state: true,
        postal_code: true,
        gst_status: true,
        tax_id: true,
      },
    })
    const store = await tx.stores.findFirst({
      where: { id: storeId, is_active: true },
      select: {
        id: true,
        name: true,
        address_line1: true,
        address_line2: true,
        city: true,
        state: true,
        postal_code: true,
      },
    })
    if (!tenant || !store) return null

    // Keep these reads sequential on the interactive transaction connection.
    // `Promise.all` does not create parallel database work inside Prisma's
    // single-connection transaction and can instead turn a setup load into a
    // burst of queued statements under a busy tenant.
    const progress = await tx.store_setup_progress.findFirst({
      where: { tenant_id: req.user!.tenantId, store_id: storeId },
    })
    const ownerOrManagerPinCount = await tx.staff_members.count({
      where: {
        is_active: true,
        pin_hash: { not: null },
        OR: [{ role: 'owner' }, { role: 'manager', store_id: storeId }],
      },
    })
    const staffCount = await tx.staff_members.count({
      where: { store_id: storeId, is_active: true, role: { in: ['manager', 'cashier'] } },
    })
    const productCount = await tx.variants.count({ where: { price: { gte: 0 } } })
    const counterCount = await tx.terminals.count({ where: { store_id: storeId, is_active: true } })
    const device = deviceHash
      ? await tx.terminals.findFirst({
          where: { device_token_hash: deviceHash, store_id: storeId, is_active: true },
          select: { id: true },
        })
      : null
    const staffId = await actingStaffId(req, tx)

    const tour = staffId
      ? await tx.staff_tour_progress.findFirst({
          where: { tenant_id: req.user!.tenantId, store_id: storeId, staff_id: staffId },
        })
      : null

    return {
      tenant,
      store,
      progress,
      tour,
      ownerOrManagerPinReady: ownerOrManagerPinCount > 0,
      staffReady: staffCount > 0,
      productReady: productCount > 0,
      counterReady: counterCount > 0,
      devicePaired: Boolean(device),
    }
  })
}

function toSetupState(facts: SetupFacts) {
  const profileReady = storeProfileValid(facts.store) && taxIdentityValid(facts.tenant)
  const teamMode = (facts.progress?.team_mode ?? null) as TeamMode | null
  const scannerChoice = (facts.progress?.scanner_choice ?? null) as SetupChoice | null
  const teamReady = teamMode === 'solo_owner' || facts.staffReady
  const deviceStatus: StepStatus = !facts.counterReady
    ? 'blocked'
    : facts.devicePaired
      ? 'complete'
      : 'incomplete'

  const steps = [
    step(
      'store_profile',
      'Confirm your store',
      'Complete the shop address and tax identity used on receipts.',
      profileReady ? 'complete' : 'incomplete',
      true,
      false,
      [],
      '/app/settings',
      profileReady ? null : 'Add the store address and a valid GST status/GSTIN.',
    ),
    step(
      'owner_pin',
      'Set a management PIN',
      'A four-digit owner or manager PIN protects counter setup and staff actions.',
      facts.ownerOrManagerPinReady ? 'complete' : 'incomplete',
      true,
      true,
      [],
      '/terminal/setup-pin?returnTo=%2Fapp%2Fsetup',
      facts.ownerOrManagerPinReady ? null : 'Create a usable owner or manager PIN.',
    ),
    step(
      'team',
      'Prepare your team',
      'Add a manager or cashier, or tell us that you operate this store alone.',
      teamReady ? 'complete' : 'incomplete',
      true,
      false,
      [],
      '/app/settings/members',
      teamReady ? null : 'Add a manager/cashier or choose solo-owner operation.',
    ),
    step(
      'products',
      'Add your first product',
      'Billing needs at least one sellable product variant with a price.',
      facts.productReady ? 'complete' : 'incomplete',
      true,
      true,
      [],
      '/app/inventory/catalog/new',
      facts.productReady ? null : 'Add or import one product variant.',
    ),
    step(
      'counter',
      'Create a counter',
      'Name the till or counter that will hold a shift.',
      facts.counterReady ? 'complete' : 'incomplete',
      true,
      true,
      [],
      '/app/settings/terminals?returnTo=%2Fapp%2Fsetup',
      facts.counterReady ? null : 'Create one active counter.',
    ),
    step(
      'device_pairing',
      'Pair this browser',
      'Pair the browser to the counter you will use for Billing.',
      deviceStatus,
      true,
      true,
      ['counter'],
      '/app/settings/terminals?returnTo=%2Fapp%2Fsetup',
      facts.counterReady
        ? facts.devicePaired
          ? null
          : 'Assign this browser to an active counter.'
        : 'Create an active counter first.',
    ),
    step(
      'scanner',
      'Test or postpone the scanner',
      'Scan a known product, choose no scanner, or configure one later.',
      scannerChoice ? 'complete' : 'incomplete',
      true,
      false,
      [],
      '/app/setup#scanner',
      scannerChoice ? null : 'Choose how this store will handle barcode scanning.',
    ),
  ]

  const complete = steps.every((entry) => entry.status === 'complete')
  const completionPercentage = Math.round((steps.filter((entry) => entry.status === 'complete').length / steps.length) * 100)
  const next = steps.find((entry) => entry.status !== 'complete')
  const billingBlockers = steps
    .filter((entry) => entry.billingBlocking && entry.status !== 'complete')
    .map((entry) => entry.title)

  return {
    store: {
      id: facts.store.id,
      name: facts.store.name,
      addressLine1: facts.store.address_line1 ?? null,
      addressLine2: facts.store.address_line2 ?? null,
      city: facts.store.city ?? null,
      state: facts.store.state ?? null,
      postalCode: facts.store.postal_code ?? null,
    },
    steps,
    complete,
    completionPercentage,
    nextAction: next?.id ?? null,
    storeReady: billingBlockers.length === 0,
    billingBlockers,
    decisions: {
      teamMode,
      scannerChoice,
      scannerVerifiedAt: iso(facts.progress?.scanner_verified_at),
      scannerVariantId: facts.progress?.scanner_variant_id ?? null,
    },
    tour: tourJson(facts.tour),
  }
}

function resolveStore(req: Request, res: any): string | null {
  try {
    return activeStoreId(req)
  } catch {
    res.status(400).json({ code: 'choose_store', error: 'Choose a store before opening guided setup' })
    return null
  }
}

router.get('/', requireRole('manager'), async (req, res) => {
  const storeId = resolveStore(req, res)
  if (!storeId) return
  const facts = await readFacts(req, storeId)
  if (!facts) return res.status(404).json({ error: 'Store not found' })
  return res.json(toSetupState(facts))
})

async function resolveDecision(req: Request, res: any) {
  const storeId = resolveStore(req, res)
  if (!storeId) return
  const parsed = SetupResolutionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid setup decision' })

  const input = parsed.data as SetupResolution
  await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const existing = await tx.store_setup_progress.findFirst({
      where: { tenant_id: req.user!.tenantId, store_id: storeId },
    })
    const data: Record<string, unknown> = {
      team_mode: existing?.team_mode ?? null,
      scanner_choice: existing?.scanner_choice ?? null,
      scanner_verified_at: existing?.scanner_verified_at ?? null,
      scanner_variant_id: existing?.scanner_variant_id ?? null,
    }

    if (input.decision === 'team_mode') data.team_mode = input.value
    if (input.decision === 'scanner_choice') {
      data.scanner_choice = input.value
      data.scanner_verified_at = null
      data.scanner_variant_id = null
    }

    if (existing) {
      await tx.store_setup_progress.update({
        where: { tenant_id_store_id: { tenant_id: req.user!.tenantId, store_id: storeId } },
        data,
      })
    } else {
      await tx.store_setup_progress.create({
        data: { tenant_id: req.user!.tenantId, store_id: storeId, ...data },
      })
    }
  })

  console.log(`[setup] decision store=${storeId.slice(0, 8)} role=${activeRole(req)} decision=${input.decision} value=${input.value}`)
  const facts = await readFacts(req, storeId)
  if (!facts) return res.status(404).json({ error: 'Store not found' })
  return res.json(toSetupState(facts))
}

// POST is the canonical resolution verb; PATCH is retained as a friendly
// compatibility alias for clients that model the progress row as a resource.
router.post('/resolve', requireRole('manager'), resolveDecision)
router.patch('/resolve', requireRole('manager'), resolveDecision)

router.post('/scanner-test', requireRole('manager'), async (req, res) => {
  const storeId = resolveStore(req, res)
  if (!storeId) return
  const parsed = ScannerTestRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter the scanner input to test' })

  const client = forTenant(req.user!.tenantId) as any
  const variant = await findExactVariant(client, parsed.data.scannedValue, req.user!.tenantId)
  if (!variant) {
    return res.json({
      status: 'no_match',
      matched: false,
      variantId: null,
      sku: null,
      productName: null,
      message: 'No exact SKU or barcode matched. Add the product or correct its barcode, then try again.',
    })
  }

  await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const existing = await tx.store_setup_progress.findFirst({
      where: { tenant_id: req.user!.tenantId, store_id: storeId },
    })
    const data = {
      team_mode: existing?.team_mode ?? null,
      scanner_choice: 'verified',
      scanner_verified_at: new Date(),
      scanner_variant_id: variant.id,
    }
    if (existing) {
      await tx.store_setup_progress.update({
        where: { tenant_id_store_id: { tenant_id: req.user!.tenantId, store_id: storeId } },
        data,
      })
    } else {
      await tx.store_setup_progress.create({ data: { tenant_id: req.user!.tenantId, store_id: storeId, ...data } })
    }
  })

  // Do not log `scannedValue`, even when it is a harmless SKU; scanners can
  // emit customer-facing identifiers and the endpoint must be safe by default.
  console.log(`[setup] scanner_verified store=${storeId.slice(0, 8)} variant=${variant.id.slice(0, 8)}`)
  return res.json({
    status: 'verified',
    matched: true,
    variantId: variant.id,
    sku: variant.sku,
    productName: variant.products?.name ?? null,
    message: 'Scanner verified against an exact catalog match.',
  })
})

async function readTour(req: Request, res: any) {
  const storeId = resolveStore(req, res)
  if (!storeId) return
  const facts = await readFacts(req, storeId)
  if (!facts) return res.status(404).json({ error: 'Store not found' })
  return res.json(toSetupState(facts).tour)
}

async function updateTour(req: Request, res: any) {
  const storeId = resolveStore(req, res)
  if (!storeId) return
  const parsed = TourProgressRequestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tour progress' })

  const staffWhere = req.actingStaff?.id
    ? {
        id: req.actingStaff.id,
        is_active: true,
        ...(activeRole(req) === 'owner' ? {} : { store_id: storeId }),
      }
    : { user_id: req.user!.id, is_active: true }
  const staffId = await forTenant(req.user!.tenantId).staff_members.findFirst({
    where: staffWhere,
    select: { id: true },
  })
  if (!staffId) return res.status(404).json({ error: 'Staff member not found' })

  const now = new Date()
  await forTenantTransaction(req.user!.tenantId, async (tx: any) => {
    const existing = await tx.staff_tour_progress.findFirst({
      where: { tenant_id: req.user!.tenantId, store_id: storeId, staff_id: staffId.id },
    })
    const previousSeen = Array.isArray(existing?.seen_steps) ? existing.seen_steps : []
    const seen = [...new Set([...(previousSeen as unknown[]), ...(parsed.data.seenSteps ?? [])])]
    const data = {
      status: parsed.data.status,
      last_step: parsed.data.lastStep === undefined ? existing?.last_step ?? null : parsed.data.lastStep,
      seen_steps: seen,
      started_at: existing?.started_at ?? (parsed.data.status === 'in_progress' ? now : null),
      skipped_at: parsed.data.status === 'skipped' ? now : null,
      completed_at: parsed.data.status === 'completed' ? now : null,
    }
    if (existing) {
      await tx.staff_tour_progress.update({
        where: {
          tenant_id_store_id_staff_id: {
            tenant_id: req.user!.tenantId,
            store_id: storeId,
            staff_id: staffId.id,
          },
        },
        data,
      })
    } else {
      await tx.staff_tour_progress.create({
        data: { tenant_id: req.user!.tenantId, store_id: storeId, staff_id: staffId.id, ...data },
      })
    }
  })

  const facts = await readFacts(req, storeId)
  if (!facts) return res.status(404).json({ error: 'Store not found' })
  return res.json(toSetupState(facts).tour)
}

router.get('/tour', requireRole('manager'), readTour)
router.patch('/tour', requireRole('manager'), updateTour)
router.post('/tour', requireRole('manager'), updateTour)

export default router
