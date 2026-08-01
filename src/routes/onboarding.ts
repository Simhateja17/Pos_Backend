import { Router } from 'express'
import type { Request } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  CompleteOnboardingSchema,
  DEFERRED_ONBOARDING_STEPS,
  OnboardingDataSchema,
  OnboardingStepNumberSchema,
  OnboardingStepSchemas,
  REQUIRED_ONBOARDING_STEPS,
  isRequiredOnboardingStep,
  type OnboardingData,
  type OnboardingStepNumber,
} from '../contracts/schemas/onboarding'

const router = Router()

const ONBOARDING_DEBUG_PREFIX = '[ONBOARDING_DEBUG]'

function maskedId(value: string | undefined): string | null {
  return value ? `${value.slice(0, 8)}…` : null
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Keep request logging useful without writing names, addresses, phone numbers,
 * tokens, or other user-entered values to PM2 logs.
 */
function summarizeBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { type: valueType(body) }
  }

  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => {
      const summary: Record<string, unknown> = {
        type: valueType(value),
        present: value !== null && value !== undefined && value !== '',
      }

      if (typeof value === 'string' || Array.isArray(value)) summary.length = value.length
      if (value && typeof value === 'object' && !Array.isArray(value)) summary.keys = Object.keys(value).sort()

      return [key, summary]
    }),
  )
}

function requestContext(req: Request): Record<string, unknown> {
  return {
    method: req.method,
    path: req.originalUrl,
    tenantId: maskedId(req.user?.tenantId),
    role: req.actingStaff?.role ?? req.user?.role ?? null,
  }
}

function onboardingLog(level: 'info' | 'error', event: string, details: Record<string, unknown>): void {
  const line = `${ONBOARDING_DEBUG_PREFIX} ${JSON.stringify({ event, ...details })}`
  if (level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
}

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { value: String(error) }
}

type TenantOnboardingRow = {
  onboarding_data: unknown
  onboarding_step: number
  onboarding_completed_at: Date | null
}

function parsePersistedData(value: unknown): OnboardingData | null {
  const parsed = OnboardingDataSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : null
}

function deriveCurrentStep(data: OnboardingData): number {
  let currentStep = 0
  for (let step = 1; step <= 8; step += 1) {
    const schema = OnboardingStepSchemas[step as OnboardingStepNumber]
    if (!schema.safeParse(data[String(step) as keyof OnboardingData]).success) {
      break
    }
    currentStep = step
  }
  return currentStep
}

function isStepComplete(data: OnboardingData, step: number): boolean {
  const schema = OnboardingStepSchemas[step as OnboardingStepNumber]
  return schema.safeParse(data[String(step) as keyof OnboardingData]).success
}

function missingRequiredSteps(data: OnboardingData): number[] {
  return REQUIRED_ONBOARDING_STEPS.filter((step) => !isStepComplete(data, step))
}

function pendingDeferredSteps(data: OnboardingData): number[] {
  return DEFERRED_ONBOARDING_STEPS.filter((step) => !isStepComplete(data, step))
}

function toState(row: TenantOnboardingRow, data: OnboardingData) {
  return {
    data,
    currentStep: deriveCurrentStep(data),
    completed: row.onboarding_completed_at !== null,
    completedAt: row.onboarding_completed_at?.toISOString() ?? null,
    requiredSteps: [...REQUIRED_ONBOARDING_STEPS],
    requiredStepsComplete: missingRequiredSteps(data).length === 0,
    pendingSteps: pendingDeferredSteps(data),
  }
}

async function findTenantOnboarding(client: any): Promise<TenantOnboardingRow | null> {
  return client.tenants.findFirst({
    select: {
      onboarding_data: true,
      onboarding_step: true,
      onboarding_completed_at: true,
    },
  })
}

router.get('/', async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const tenant = await findTenantOnboarding(client)
  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' })
  }

  const data = parsePersistedData(tenant.onboarding_data)
  if (!data) {
    return res.status(500).json({ error: 'Stored onboarding data is invalid' })
  }

  return res.json(toState(tenant, data))
})

router.put('/steps/:step', requireRole('owner'), async (req, res) => {
  onboardingLog('info', 'save_received', {
    ...requestContext(req),
    stepParam: req.params.step,
    body: summarizeBody(req.body),
  })

  const parsedStep = OnboardingStepNumberSchema.safeParse(req.params.step)
  if (!parsedStep.success) {
    onboardingLog('error', 'invalid_step', {
      ...requestContext(req),
      stepParam: req.params.step,
      issues: parsedStep.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
    })
    return res.status(400).json({ error: 'Invalid onboarding step' })
  }

  const step = parsedStep.data as OnboardingStepNumber
  const parsedBody = OnboardingStepSchemas[step].safeParse(req.body)
  if (!parsedBody.success) {
    onboardingLog('error', 'validation_failed', {
      ...requestContext(req),
      step,
      issues: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
      body: summarizeBody(req.body),
    })
    return res.status(400).json({ error: 'Invalid onboarding step data' })
  }

  try {
    const client = forTenant(req.user!.tenantId) as any
    const tenant = await findTenantOnboarding(client)
    if (!tenant) {
      onboardingLog('error', 'tenant_not_found', { ...requestContext(req), step })
      return res.status(404).json({ error: 'Tenant not found' })
    }
    if (tenant.onboarding_completed_at && isRequiredOnboardingStep(step)) {
      onboardingLog('error', 'already_complete', { ...requestContext(req), step })
      return res.status(409).json({ error: 'Onboarding is already complete' })
    }

    const existingData = parsePersistedData(tenant.onboarding_data)
    if (!existingData) {
      onboardingLog('error', 'stored_data_invalid', { ...requestContext(req), step })
      return res.status(500).json({ error: 'Stored onboarding data is invalid' })
    }

    // Required steps run in order. Deferred steps ("finish later") unlock in any
    // order once the required setup is done — they are reached from inside the app.
    const missingRequired = missingRequiredSteps(existingData)
    const nextRequiredStep = missingRequired[0]
    const blocked = isRequiredOnboardingStep(step)
      ? nextRequiredStep !== undefined && step > nextRequiredStep
      : missingRequired.length > 0
    if (blocked) {
      onboardingLog('error', 'step_blocked', {
        ...requestContext(req),
        step,
        missingRequired,
        nextRequiredStep: nextRequiredStep ?? null,
      })
      return res.status(409).json({
        error: 'Complete the required onboarding steps first',
        nextStep: nextRequiredStep,
      })
    }

    const data = {
      ...existingData,
      [String(step)]: parsedBody.data,
    } as OnboardingData
    const nextStep = deriveCurrentStep(data)
    const updated = await client.tenants.update({
      where: { id: req.user!.tenantId },
      data: {
        onboarding_data: data,
        onboarding_step: nextStep,
      },
      select: {
        onboarding_data: true,
        onboarding_step: true,
        onboarding_completed_at: true,
      },
    })

    onboardingLog('info', 'save_succeeded', { ...requestContext(req), step, nextStep })
    return res.json(toState(updated, data))
  } catch (error) {
    onboardingLog('error', 'save_exception', { ...requestContext(req), step, error: errorSummary(error) })
    throw error
  }
})

router.post('/complete', requireRole('owner'), async (req, res) => {
  const parsedBody = CompleteOnboardingSchema.safeParse(req.body ?? {})
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Invalid completion request' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const tenant = await findTenantOnboarding(client)
  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' })
  }

  const data = parsePersistedData(tenant.onboarding_data)
  if (!data) {
    return res
      .status(409)
      .json({ error: 'Onboarding is incomplete', missingSteps: [...REQUIRED_ONBOARDING_STEPS] })
  }

  // ONBOARD-01: only the required steps gate completion.
  const missingSteps = missingRequiredSteps(data)

  if (missingSteps.length > 0) {
    return res.status(409).json({ error: 'Onboarding is incomplete', missingSteps })
  }

  const completedAt = tenant.onboarding_completed_at ?? new Date()
  const completed = tenant.onboarding_completed_at
    ? tenant
    : await client.tenants.update({
        where: { id: req.user!.tenantId },
        data: {
          onboarding_step: deriveCurrentStep(data),
          onboarding_completed_at: completedAt,
        },
        select: {
          onboarding_data: true,
          onboarding_step: true,
          onboarding_completed_at: true,
        },
      })

  const businessIdentity = data['1']!
  const gstCompliance = data['2']!

  return res.json({
    ...toState(completed, data),
    summary: {
      businessName: businessIdentity.tradeName ?? businessIdentity.legalName,
      storeName: data['3']?.storeName ?? null,
      storeCategory: businessIdentity.storeCategory,
      trialPlan: businessIdentity.trialPlan,
      billingCounters: data['7']?.billingCounters ?? null,
      gstStatus: gstCompliance.gstStatus,
    },
  })
})

export default router
