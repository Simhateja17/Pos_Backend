import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createCounterDeviceToken, hashCounterDeviceToken, COUNTER_DEVICE_COOKIE } from '../../src/lib/counterDevice'

/**
 * Pairs a fake browser to a real counter (terminal).
 *
 * POST /terminal/pin/switch refuses any non-management session with 409
 * ("Assign this device to a counter before staff can sign in") unless the
 * request carries a `couture_counter_device` cookie whose SHA-256 hash
 * matches a terminal's `device_token_hash`. A cashier PIN switch therefore
 * cannot be tested at all without a paired device.
 *
 * `seedTwoTenants` creates no terminals, which is a pre-existing fixture gap
 * rather than an auth problem — the same class of gap as the missing billing
 * row in ./entitlement.ts. Both belong in seed.ts proper; they are kept
 * separate only to avoid colliding with the Phase 8 edits in flight there.
 *
 * store_id is passed explicitly rather than left to the 0045 BEFORE INSERT
 * shim, which fills it with the tenant's oldest store. That shim is scheduled
 * for removal, and a fixture that depends on it would start failing the day
 * it goes.
 *
 * No cleanup is needed — `cleanupSeed` deletes the tenant and the FK cascades.
 */
const superPrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

export interface PairedTerminal {
  terminalId: string
  /** Ready to hand to supertest's .set('Cookie', ...). */
  deviceCookie: string
}

export async function pairDeviceToTerminal(tenantId: string, storeId: string): Promise<PairedTerminal> {
  const token = createCounterDeviceToken()
  const now = new Date()

  const terminal = await superPrisma.terminals.create({
    data: {
      tenant_id: tenantId,
      store_id: storeId,
      name: `Test Counter ${now.getTime()}`,
      is_active: true,
      device_token_hash: hashCounterDeviceToken(token),
      device_paired_at: now,
      device_last_seen_at: now,
    },
  })

  return {
    terminalId: terminal.id,
    deviceCookie: `${COUNTER_DEVICE_COOKIE}=${encodeURIComponent(token)}`,
  }
}
