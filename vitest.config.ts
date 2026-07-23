import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    // 01-09's integration tests hit a real live Supabase project (auth user
    // creation/deletion, real Postgres writes/reads) — the vitest defaults
    // (5s test / 10s hook) are too short for that real network+bcrypt work.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
})
