import fs from 'node:fs'
import path from 'node:path'
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { SignupSchema, LoginSchema, AuthResponseSchema, SetPinSchema } from './schemas/auth'
import { MemberSchema, InviteMemberSchema, UpdateMemberRoleSchema } from './schemas/member'
import { PinSwitchSchema, PinSwitchResponseSchema } from './schemas/pin'
import { ProductSchema, CreateProductSchema, VariantSchema, UpdateVariantSchema } from './schemas/product'
import { StockMovementSchema, CreateStockMovementSchema, LowStockVariantSchema } from './schemas/stockMovement'
import { CreateSaleSchema, SaleSchema, SaleListQuerySchema, SaleListSchema, ResendReceiptInputSchema, ResendReceiptResponseSchema } from './schemas/sale'
import { CreateReturnSchema } from './schemas/return'
import { CustomerListQuerySchema, CustomerListSchema, CustomerSchema } from './schemas/customer'
import { PaymentReadQuerySchema, PaymentReadSchema } from './schemas/payment'
import { AppContextSchema } from './schemas/context'
import { DashboardQuerySchema, DashboardSchema } from './schemas/dashboard'
import { OpenShiftSchema, CloseShiftSchema, ShiftSchema, XReportSchema, ZReportSchema } from './schemas/shift'
import {
  CompleteOnboardingSchema,
  OnboardingCompletionResponseSchema,
  OnboardingStateSchema,
  OnboardingStepInputSchema,
  OnboardingStepNumberSchema,
} from './schemas/onboarding'
import { SupplierSchema, SupplierListSchema, CreateSupplierInputSchema, UpdateSupplierInputSchema } from './schemas/supplier'
import { ReorderSuggestionListSchema } from './schemas/reorder'
import {
  PurchaseOrderSchema,
  PurchaseOrderListSchema,
  CreatePurchaseOrderSchema,
  UpdatePurchaseOrderSchema,
  ReceivePurchaseOrderSchema,
  ReceiptResultSchema,
} from './schemas/purchaseOrder'

// extendZodWithOpenApi(z) is NOT called here — `./schemas/auth.ts` already
// calls it exactly once at process load, and this file imports schemas from
// that module (transitively loading it first), so a second call against the
// same `zod` module instance would be redundant/unsafe. See that file's
// comment for the authoritative single-call-site note.

const registry = new OpenAPIRegistry()

registry.registerPath({
  method: 'get',
  path: '/context',
  description: 'Read the authenticated caller and tenant display context for the application shell.',
  responses: {
    200: { description: 'Authenticated application context', content: { 'application/json': { schema: AppContextSchema } } },
    401: { description: 'Unauthenticated' },
    404: { description: 'Tenant not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/dashboard',
  description: 'Read bounded, authenticated tenant dashboard facts. Metrics without persisted source data are explicitly unavailable.',
  request: { query: DashboardQuerySchema },
  responses: {
    200: { description: 'Tenant dashboard read model', content: { 'application/json': { schema: DashboardSchema } } },
    400: { description: 'Invalid dashboard range' },
    401: { description: 'Unauthenticated' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/onboarding',
  description: "Read the authenticated tenant's server-owned onboarding draft and completion state.",
  responses: {
    200: { description: 'Persisted onboarding state', content: { 'application/json': { schema: OnboardingStateSchema } } },
    401: { description: 'Unauthenticated' },
  },
})

registry.registerPath({
  method: 'put',
  path: '/onboarding/steps/{step}',
  description: 'Save one validated onboarding step for the authenticated tenant. Owner-only.',
  request: {
    params: z.object({ step: OnboardingStepNumberSchema }),
    body: { content: { 'application/json': { schema: OnboardingStepInputSchema } } },
  },
  responses: {
    200: { description: 'Onboarding step saved', content: { 'application/json': { schema: OnboardingStateSchema } } },
    400: { description: 'Invalid step or step payload' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    409: { description: 'Earlier steps are incomplete or onboarding is already complete' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/onboarding/complete',
  description: 'Complete onboarding only after all eight persisted steps pass server validation. Owner-only.',
  request: {
    body: { content: { 'application/json': { schema: CompleteOnboardingSchema } } },
  },
  responses: {
    200: { description: 'Onboarding completed', content: { 'application/json': { schema: OnboardingCompletionResponseSchema } } },
    400: { description: 'Invalid completion request' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    409: { description: 'One or more required onboarding steps are incomplete' },
  },
})

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
  description: "List the caller's tenant's products with variants and current stock. Optional `search` filters to an exact-sku or partial-name match (CHECK-01/CHECK-02).",
  request: { query: z.object({ search: z.string().optional() }) },
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
  path: '/sales/records',
  description: 'List tenant-scoped sales with bounded pagination and optional safe filters.',
  request: { query: SaleListQuerySchema },
  responses: {
    200: { description: 'Paginated sales', content: { 'application/json': { schema: SaleListSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/sales',
  description: 'Look up prior sales by receipt number or customer search for returns compatibility.',
  request: { query: z.object({ receiptNumber: z.string().uuid().optional(), customerSearch: z.string().max(100).optional() }) },
  responses: {
    200: { description: 'Matching sales', content: { 'application/json': { schema: z.array(SaleSchema) } } },
    400: { description: 'A receipt number or customer search is required' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/sales/payments',
  description: 'Read tenant-scoped payment records and server-calculated collected/refunded totals.',
  request: { query: PaymentReadQuerySchema },
  responses: {
    200: { description: 'Paginated payment records and authoritative totals', content: { 'application/json': { schema: PaymentReadSchema } } },
    400: { description: 'Invalid payment filters' },
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

registry.registerPath({
  method: 'post',
  path: '/returns',
  description: "Process a partial or full return/refund against a prior sale (CHECK-07, D-09 through D-12). Writes a positive-delta return stock movement and refund payment row(s) against the original payment method — server-validated against the original sale's actual payment methods (D-10).",
  request: { body: { content: { 'application/json': { schema: CreateReturnSchema } } } },
  responses: {
    201: { description: 'Return processed' },
    400: { description: 'Invalid request, over-return, refund-sum mismatch, or refund method not used on the original sale' },
    404: { description: 'Sale or line item not found' },
    409: { description: 'Target shift is already closed' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/customers/records',
  description: 'List tenant-scoped customers with bounded pagination and optional safe search.',
  request: { query: CustomerListQuerySchema },
  responses: {
    200: { description: 'Paginated customers', content: { 'application/json': { schema: CustomerListSchema } } },
    400: { description: 'Invalid customer filters' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/customers',
  description: 'Search customers by phone, email, or name for checkout compatibility.',
  request: { query: z.object({ search: z.string().max(100).optional() }) },
  responses: {
    200: { description: 'Matching customers', content: { 'application/json': { schema: z.array(CustomerSchema) } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/sales/{saleId}/resend-receipt',
  description: 'Resend a receipt email for a completed sale (CHECK-06) — resolves a real target email and reports the actual send outcome.',
  request: {
    params: z.object({ saleId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: ResendReceiptInputSchema } } },
  },
  responses: {
    200: { description: 'Receipt sent', content: { 'application/json': { schema: ResendReceiptResponseSchema } } },
    400: { description: 'No email address available' },
    404: { description: 'Sale not found' },
    502: { description: 'Email delivery failed' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/shifts',
  description: 'Open a shift with a starting cash count (D-14).',
  request: { body: { content: { 'application/json': { schema: OpenShiftSchema } } } },
  responses: {
    201: { description: 'Shift opened', content: { 'application/json': { schema: ShiftSchema } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/shifts/{shiftId}/x-report',
  description: 'Live, non-resetting shift snapshot (D-15, CASH-02).',
  request: { params: z.object({ shiftId: z.string().uuid() }) },
  responses: {
    200: { description: 'X report', content: { 'application/json': { schema: XReportSchema } } },
    404: { description: 'Shift not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/shifts/{shiftId}/close',
  description: 'Close a shift (Z report) — counted cash, variance, locks the shift (D-15/D-16).',
  request: {
    params: z.object({ shiftId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: CloseShiftSchema } } },
  },
  responses: {
    200: { description: 'Shift closed', content: { 'application/json': { schema: ZReportSchema } } },
    404: { description: 'Shift not found' },
    409: { description: 'Shift already closed' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/suppliers',
  description: "List the caller's tenant's suppliers, active first.",
  responses: {
    200: { description: 'List of suppliers', content: { 'application/json': { schema: SupplierListSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/suppliers',
  description: 'Create a supplier. leadTimeDays is a direct input to the reorder heuristic (Phase 5 Task 5) and is required.',
  request: { body: { content: { 'application/json': { schema: CreateSupplierInputSchema } } } },
  responses: {
    201: { description: 'Supplier created', content: { 'application/json': { schema: SupplierSchema } } },
    400: { description: 'Invalid request' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/suppliers/{supplierId}',
  description: 'Get a single supplier.',
  request: { params: z.object({ supplierId: z.string().uuid() }) },
  responses: {
    200: { description: 'Supplier', content: { 'application/json': { schema: SupplierSchema } } },
    404: { description: 'Supplier not found' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/suppliers/{supplierId}',
  description: 'Edit a supplier, or deactivate/reactivate via isActive. There is no delete — past purchase orders keep referencing this row.',
  request: {
    params: z.object({ supplierId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateSupplierInputSchema } } },
  },
  responses: {
    200: { description: 'Supplier updated', content: { 'application/json': { schema: SupplierSchema } } },
    404: { description: 'Supplier not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/purchase-orders',
  description: "List the caller's tenant's purchase orders, newest first. Optional `status` filter.",
  request: { query: z.object({ status: z.string().optional() }) },
  responses: {
    200: { description: 'Purchase orders', content: { 'application/json': { schema: PurchaseOrderListSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/purchase-orders',
  description: 'Raise a draft purchase order against a supplier (PUR-02).',
  request: { body: { content: { 'application/json': { schema: CreatePurchaseOrderSchema } } } },
  responses: {
    201: { description: 'Purchase order created', content: { 'application/json': { schema: PurchaseOrderSchema } } },
    400: { description: 'Invalid request or unknown variant' },
    404: { description: 'Supplier not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/purchase-orders/{poId}',
  description: 'Get a single purchase order with its lines.',
  request: { params: z.object({ poId: z.string().uuid() }) },
  responses: {
    200: { description: 'Purchase order', content: { 'application/json': { schema: PurchaseOrderSchema } } },
    404: { description: 'Purchase order not found' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/purchase-orders/{poId}',
  description: 'Send or cancel a purchase order, or edit expected date/notes. partial/received are derived by the receipt trigger and cannot be set here.',
  request: {
    params: z.object({ poId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdatePurchaseOrderSchema } } },
  },
  responses: {
    200: { description: 'Purchase order updated', content: { 'application/json': { schema: PurchaseOrderSchema } } },
    404: { description: 'Purchase order not found' },
    409: { description: 'Purchase order is already received or cancelled' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/purchase-orders/{poId}/receive',
  description:
    'Record a goods receipt. Partial receipt is the normal case. Idempotent on (tenant, clientReceiptId) — a replay returns the original receipt and changes nothing. Over-receipt is allowed but reported in overReceived.',
  request: {
    params: z.object({ poId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: ReceivePurchaseOrderSchema } } },
  },
  responses: {
    201: { description: 'Receipt recorded', content: { 'application/json': { schema: ReceiptResultSchema } } },
    200: { description: 'Receipt was already recorded (replay)', content: { 'application/json': { schema: ReceiptResultSchema } } },
    400: { description: 'Invalid request or lines not on this purchase order' },
    404: { description: 'Purchase order not found' },
    409: { description: 'Purchase order is draft or cancelled, or this receipt was already recorded' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/reorder/suggestions',
  description:
    'Current rule-based reorder suggestions (ML-01). Does not generate on read — refreshing shows the same numbers. Each suggestion carries the structured data basis that produced it (ML-03).',
  responses: {
    200: { description: 'Reorder suggestions', content: { 'application/json': { schema: ReorderSuggestionListSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/reorder/generate',
  description:
    'Recompute rule-based reorder suggestions for this tenant, replacing the previous run. Manager or owner only. This is velocity x lead time arithmetic, not a forecast.',
  responses: {
    200: { description: 'Suggestions regenerated', content: { 'application/json': { schema: ReorderSuggestionListSchema } } },
    403: { description: 'Insufficient permissions' },
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
