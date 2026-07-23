// Loads backend/.env into process.env before any test file's top-level code
// runs. Required for 01-09's integration tests (rls-enforcement, role-gating,
// login, invite-flow), which hit the REAL live Supabase test project and need
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY /
// DATABASE_URL / RLS_DATABASE_URL populated from .env, not hand-set fixture
// values. Unit test files from prior plans (auth.test.ts, members.test.ts,
// etc.) already set their own fake process.env.* values at the top of the
// file, AFTER this setup file runs — dotenv/config never clobbers a value a
// test file assigns afterward, so this is safe to add without touching any
// prior plan's test files.
import 'dotenv/config'
