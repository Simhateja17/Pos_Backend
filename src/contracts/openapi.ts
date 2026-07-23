import fs from 'node:fs'
import path from 'node:path'
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { SignupSchema, LoginSchema, AuthResponseSchema } from './schemas/auth'
import { MemberSchema, InviteMemberSchema, UpdateMemberRoleSchema } from './schemas/member'

// extendZodWithOpenApi(z) is NOT called here — `./schemas/auth.ts` already
// calls it exactly once at process load, and this file imports schemas from
// that module (transitively loading it first), so a second call against the
// same `zod` module instance would be redundant/unsafe. See that file's
// comment for the authoritative single-call-site note.

const registry = new OpenAPIRegistry()

registry.registerPath({
  method: 'post',
  path: '/auth/signup',
  description: 'Real self-serve signup — creates a Supabase Auth user, a tenants row with the full business/tax profile, and an owner staff_members row.',
  request: {
    body: { content: { 'application/json': { schema: SignupSchema } } },
  },
  responses: {
    201: { description: 'Signup successful', content: { 'application/json': { schema: AuthResponseSchema } } },
    409: { description: 'An account already exists with this email' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  description: 'Email+password login via Supabase Auth. Derives role/tenantId from a server-side staff_members lookup.',
  request: {
    body: { content: { 'application/json': { schema: LoginSchema } } },
  },
  responses: {
    200: { description: 'Login successful', content: { 'application/json': { schema: AuthResponseSchema } } },
    401: { description: 'Invalid email or password' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/members',
  description: "List the caller's tenant's staff members. Requires manager or owner role.",
  responses: {
    200: { description: 'List of staff members', content: { 'application/json': { schema: z.array(MemberSchema) } } },
    403: { description: 'Insufficient permissions' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/members/invite',
  description: 'Invite a new staff member (manager or cashier) into the caller\'s tenant. Owner-only.',
  request: {
    body: { content: { 'application/json': { schema: InviteMemberSchema } } },
  },
  responses: {
    201: { description: 'Invite sent and staff row created', content: { 'application/json': { schema: MemberSchema } } },
    403: { description: 'Insufficient permissions' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/members/{memberId}/role',
  description: "Change a staff member's role. Owner-only.",
  request: {
    params: z.object({ memberId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateMemberRoleSchema } } },
  },
  responses: {
    200: { description: 'Role updated', content: { 'application/json': { schema: MemberSchema } } },
    403: { description: 'Insufficient permissions' },
    404: { description: 'Member not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/members/{memberId}',
  description: 'Soft-delete (deactivate) a staff member. Owner-only.',
  request: {
    params: z.object({ memberId: z.string().uuid() }),
  },
  responses: {
    200: { description: 'Member deactivated', content: { 'application/json': { schema: MemberSchema } } },
    403: { description: 'Insufficient permissions' },
    404: { description: 'Member not found' },
  },
})

// Note for 01-13 (later wave): that plan adds a 7th path, POST /auth/set-pin,
// to this same registry — append another registry.registerPath(...) call,
// this construction is a simple sequence, not a closed/frozen structure.

const generator = new OpenApiGeneratorV31(registry.definitions)

export const openApiDocument = generator.generateDocument({
  openapi: '3.1.0',
  info: { title: 'Couture POS API', version: '1.0.0' },
})

if (require.main === module) {
  const outPath = path.join(__dirname, '..', '..', 'openapi.json')
  fs.writeFileSync(outPath, JSON.stringify(openApiDocument, null, 2))
  // eslint-disable-next-line no-console
  console.log(`Wrote OpenAPI document to ${outPath}`)
}
