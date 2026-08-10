import { defineConfig } from 'vitest/config'

/**
 * The eleven suites that talk to the real Supabase project — real auth users,
 * real Postgres writes, real RLS. Everything else in tests/ is mocked and has
 * no shared external state.
 *
 * Keep this list in sync when a suite starts or stops using
 * tests/fixtures/seed.ts, DATABASE_URL or RLS_DATABASE_URL. A DB-backed file
 * left out of it runs in the parallel project and reintroduces the flakiness
 * below.
 */
const DB_BACKED = [
  'tests/auth/login.test.ts',
  'tests/auth/role-gating.test.ts',
  'tests/auth/staff-pin-flow.test.ts',
  'tests/checkout/returns.test.ts',
  'tests/checkout/sale-idempotency.test.ts',
  'tests/checkout/shift-reconciliation.test.ts',
  'tests/checkout/stock-floor-sale.test.ts',
  'tests/inventory/stock-trigger.test.ts',
  'tests/tenancy/purchase-orders-rls.test.ts',
  'tests/tenancy/rls-enforcement.test.ts',
  'tests/tenancy/suppliers-rls.test.ts',
]

// Real network + bcrypt + live Postgres. The vitest defaults (5s test /
// 10s hook) are far too short for that work.
const TIMEOUTS = { testTimeout: 30000, hookTimeout: 90000 }

export default defineConfig({
  test: {
    projects: [
      {
        // Everything mocked: safe to run wide open.
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: DB_BACKED,
          setupFiles: ['./tests/setup-env.ts'],
          ...TIMEOUTS,
        },
      },
      {
        /**
         * All eleven share ONE live Supabase project. Run in parallel they
         * contend for the same connection pool (Supavisor transaction mode)
         * and the same Auth admin rate limits, which is why sale-idempotency
         * — 50 concurrent submissions of one sale — and suppliers-rls passed
         * alone and failed intermittently in a full run.
         *
         * The failures were contention, never logic: seed.ts already
         * namespaces every tenant, email and business name by a random runId,
         * so the suites were not colliding on data.
         *
         * fileParallelism: false runs these one file at a time. It costs
         * wall-clock time on a suite that is already network-bound, and buys
         * a full run whose result can be trusted — which an intermittently
         * red suite cannot give at any speed.
         */
        test: {
          name: 'db',
          environment: 'node',
          include: DB_BACKED,
          setupFiles: ['./tests/setup-env.ts'],
          fileParallelism: false,
          ...TIMEOUTS,
        },
      },
    ],
  },
})
