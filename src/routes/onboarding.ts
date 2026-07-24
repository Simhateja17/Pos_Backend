import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  CompleteOnboardingSchema,
  OnboardingDataSchema,
  OnboardingStepNumberSchema,
  OnboardingStepSchemas,
  type OnboardingData,
  type OnboardingStepNumber,
} from '../contracts/schemas/onboarding'

const router = Router()

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

function toState(row: TenantOnboardingRow, data: OnboardingData) {
  return {
    data,
    currentStep: deriveCurrentStep(data),
    completed: row.onboarding_completed_at !== null,
    completedAt: row.onboarding_completed_at?.toISOString() ?? null,
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
  const parsedStep = OnboardingStepNumberSchema.safeParse(req.params.step)
  if (!parsedStep.success) {
    return res.status(400).json({ error: 'Invalid onboarding step' })
  }

  const step = parsedStep.data as OnboardingStepNumber
  const parsedBody = OnboardingStepSchemas[step].safeParse(req.body)
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Invalid onboarding step data' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const tenant = await findTenantOnboarding(client)
  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' })
  }
  if (tenant.onboarding_completed_at) {
    return res.status(409).json({ error: 'Onboarding is already complete' })
  }

  const existingData = parsePersistedData(tenant.onboarding_data)
  if (!existingData) {
    return res.status(500).json({ error: 'Stored onboarding data is invalid' })
  }

  const currentStep = deriveCurrentStep(existingData)
  if (step > currentStep + 1) {
    return res.status(409).json({
      error: 'Complete earlier onboarding steps first',
      nextStep: currentStep + 1,
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

  return res.json(toState(updated, data))
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
    return res.status(409).json({ error: 'Onboarding is incomplete', missingSteps: [1, 2, 3, 4, 5, 6, 7, 8] })
  }

  const missingSteps = Object.entries(OnboardingStepSchemas)
    .filter(([step, schema]) => !schema.safeParse(data[step as keyof OnboardingData]).success)
    .map(([step]) => Number(step))

  if (missingSteps.length > 0) {
    return res.status(409).json({ error: 'Onboarding is incomplete', missingSteps })
  }

  const completedAt = tenant.onboarding_completed_at ?? new Date()
  const completed = tenant.onboarding_completed_at
    ? tenant
    : await client.tenants.update({
        where: { id: req.user!.tenantId },
        data: {
          onboarding_step: 8,
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
  const storeSetup = data['3']!
  const hardware = data['7']!

  return res.json({
    ...toState(completed, data),
    summary: {
      businessName: businessIdentity.tradeName ?? businessIdentity.legalName,
      storeName: storeSetup.storeName,
      storeCategory: businessIdentity.storeCategory,
      trialPlan: businessIdentity.trialPlan,
      billingCounters: hardware.billingCounters,
      gstStatus: gstCompliance.gstStatus,
    },
  })
})

export default router

