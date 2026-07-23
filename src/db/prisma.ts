import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// Base client connected as the restricted app_runtime role (NOBYPASSRLS).
// NEVER connect this to the postgres superuser connection string — that would silently
// bypass RLS and make success criterion #2 (cross-tenant read refused by Postgres) untestable.
// This is deliberately RLS_DATABASE_URL, not DATABASE_URL (which is the superuser
// connection reserved for Prisma introspection/migrations only, per backend/.env.example).
//
// Prisma 7 removed the constructor-level `datasources.url` override entirely — a
// driver adapter is now required for any non-Accelerate connection. `@prisma/adapter-pg`
// wraps a `pg` Pool pointed at RLS_DATABASE_URL, which is functionally equivalent to the
// old override for this project's purposes.
const adapter = new PrismaPg({ connectionString: process.env.RLS_DATABASE_URL })

export const basePrisma = new PrismaClient({ adapter })
