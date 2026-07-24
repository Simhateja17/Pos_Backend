import fs from 'node:fs'
import path from 'node:path'
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { SignupSchema, LoginSchema, AuthResponseSchema, SetPinSchema } from './schemas/auth'
import { MemberSchema, InviteMemberSchema, UpdateMemberRoleSchema } from './schemas/member'
import { PinSwitchSchema, PinSwitchResponseSchema } from './schemas/pin'
import { ProductSchema, CreateProductSchema, VariantSchema, UpdateVariantSchema } from './schemas/product'
import { StockMovementSchema, CreateStockMovementSchema, LowStockVariantSchema } from './schemas/stockMovement'
import { CreateSaleSchema, SaleSchema } from './schemas/sale'

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

registry.registerPath({
  method: 'get',
  path: '/products',
  description: "List the caller's tenant's products with variants and current stock.",
  responses: {
    200: { description: 'List of products', content: { 'application/json': { schema: z.array(ProductSchema) } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/products',
  description: 'Create a product with one or more variants (D-01/D-02). SKU auto-generated per variant unless supplied.',
  request: { body: { content: { 'application/json': { schema: CreateProductSchema } } } },
  responses: {
    201: { description: 'Product created', content: { 'application/json': { schema: ProductSchema } } },
    400: { description: 'Invalid request' },
    409: { description: 'SKU collision' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/products/{productId}',
  description: 'Get a single product with its variants and current stock.',
  request: { params: z.object({ productId: z.string().uuid() }) },
  responses: {
    200: { description: 'Product', content: { 'application/json': { schema: ProductSchema } } },
    404: { description: 'Product not found' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/products/{productId}/variants/{variantId}',
  description: "Edit a variant. Price/reorderThreshold always editable; size/color/material blocked once stock has moved (D-04).",
  request: {
    params: z.object({ productId: z.string().uuid(), variantId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateVariantSchema } } },
  },
  responses: {
    200: { description: 'Variant updated', content: { 'application/json': { schema: VariantSchema } } },
    404: { description: 'Variant not found' },
    409: { description: 'Variant identity is locked' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/stock-movements',
  description: 'Record a stock movement (receive/adjustment/transfer). Adjustment requires manager or owner role (D-13).',
  request: { body: { content: { 'application/json': { schema: CreateStockMovementSchema } } } },
  responses: {
    201: { description: 'Movement recorded', content: { 'application/json': { schema: StockMovementSchema } } },
    400: { description: 'Invalid request' },
    403: { description: 'Insufficient permissions (adjustment requires manager+)' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/stock-movements',
  description: 'Read-only movement history for a variant.',
  request: { query: z.object({ variantId: z.string().uuid() }) },
  responses: {
    200: { description: 'Movement history', content: { 'application/json': { schema: z.array(StockMovementSchema) } } },
    400: { description: 'variantId is required' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/stock-movements/low-stock',
  description: 'Variants at or below their reorder threshold (INV-03).',
  responses: {
    200: { description: 'Low-stock variants', content: { 'application/json': { schema: z.array(LowStockVariantSchema) } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/set-pin',
  description: 'An authenticated staff member (owner, manager, or a newly-activated invited manager/cashier) provisions/changes their own PIN. Requires a real Supabase session (authMiddleware) — never the PIN-switch mechanism. Always targets the caller\'s own staff_members row.',
  request: {
    body: { content: { 'application/json': { schema: SetPinSchema } } },
  },
  responses: {
    200: { description: 'PIN set', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
    400: { description: 'Invalid PIN' },
    404: { description: 'No staff record found for this account' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/terminal/pin/switch',
  description: 'PIN-switch the acting operator on a shared terminal. Requires an existing authenticated session (authMiddleware); does not create a new Supabase Auth session — issues a short-lived signed operator token instead (D-09/D-10).',
  request: {
    body: { content: { 'application/json': { schema: PinSwitchSchema } } },
  },
  responses: {
    200: { description: 'PIN-switch successful', content: { 'application/json': { schema: PinSwitchResponseSchema } } },
    401: { description: 'Incorrect PIN, locked out, or unauthenticated' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/sales',
  description: "Complete a checkout sale — server recomputes totals, enforces payment-sum, gates above-threshold discounts behind manager+ approval (D-05), writes sale+lines+payments+stock movements atomically. Response includes the sale's payments array.",
  request: { body: { content: { 'application/json': { schema: CreateSaleSchema } } } },
  responses: {
    201: { description: 'Sale completed', content: { 'application/json': { schema: SaleSchema } } },
    400: { description: 'Invalid request, variant not found, or payment sum mismatch' },
    403: { description: "Discount exceeds the tenant's manager-approval threshold and the acting role is not manager+" },
    409: { description: 'Target shift is already closed' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/sales',
  description: 'Look up prior sales by receipt number or customer search (D-09). Each returned sale includes its lines and payments.',
  request: { query: z.object({ receiptNumber: z.string().uuid().optional(), customerSearch: z.string().optional() }) },
  responses: {
    200: { description: 'Matching sales', content: { 'application/json': { schema: z.array(SaleSchema) } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/sales/{saleId}',
  description: 'Get a single sale with its line items and payments.',
  request: { params: z.object({ saleId: z.string().uuid() }) },
  responses: {
    200: { description: 'Sale', content: { 'application/json': { schema: SaleSchema } } },
    404: { description: 'Sale not found' },
  },
})

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
