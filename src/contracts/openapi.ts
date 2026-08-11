import fs from 'node:fs'
import path from 'node:path'
import { StoreSettingsSchema, UpdateStoreSettingsSchema } from './schemas/settings'
import { NotificationListSchema } from './schemas/notification'
import {
  CategorySchema,
  CreateCategorySchema,
  UpdateCategorySchema,
  SeedCategoriesSchema,
} from './schemas/category'
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import {
  SignupSchema,
  LoginSchema,
  OtpRequestSchema,
  OwnerPinRecoveryRequestSchema,
  AuthResponseSchema,
  SetPinSchema,
} from './schemas/auth'
import {
  CreateStaffSchema,
  InviteMemberSchema,
  MemberSchema,
  ResetStaffPinSchema,
  UpdateMemberRoleSchema,
} from './schemas/member'
import { ChangeOperatorPinSchema, PinSwitchSchema, PinSwitchResponseSchema, StaffSessionSchema } from './schemas/pin'
import { ProductSchema, CreateProductSchema, VariantSchema, UpdateVariantSchema } from './schemas/product'
import { StockMovementSchema, CreateStockMovementSchema, LowStockVariantSchema } from './schemas/stockMovement'
import { CreateSaleSchema, SaleSchema, SaleListQuerySchema, SaleListSchema, ResendReceiptInputSchema, ResendReceiptResponseSchema } from './schemas/sale'
import { CreateReturnSchema } from './schemas/return'
import { CustomerListQuerySchema, CustomerListSchema, CustomerSchema } from './schemas/customer'
import { PaymentReadQuerySchema, PaymentReadSchema } from './schemas/payment'
import { AppContextSchema } from './schemas/context'
import { DashboardQuerySchema, DashboardSchema } from './schemas/dashboard'
import {
  CloseShiftSchema,
  CurrentShiftSchema,
  OpenShiftSchema,
  ShiftSchema,
  ShiftHistoryEntrySchema,
  XReportSchema,
  ZReportSchema,
} from './schemas/shift'
import { TerminalSchema, CreateTerminalSchema, UpdateTerminalSchema } from './schemas/terminal'
import { StoreSchema, CreateStoreSchema, UpdateStoreSchema, StoreListSchema } from './schemas/store'
import { VariantAvailabilitySchema } from './schemas/availability'
import {
  CreateStockTransferSchema,
  ReceiveStockTransferSchema,
  StockTransferListSchema,
  StockTransferSchema,
  TransferDestinationListSchema,
} from './schemas/transfer'
import {
  CompleteOnboardingSchema,
  OnboardingCompletionResponseSchema,
  OnboardingStateSchema,
  OnboardingStepInputSchema,
  OnboardingStepNumberSchema,
} from './schemas/onboarding'
import {
  CommitImportSchema,
  ImportBatchListSchema,
  ImportBatchSchema,
  ImportCommitResultSchema,
  MappingSuggestionSchema,
  UploadImportSchema,
} from './schemas/import'
import { ReportCatalogSchema, ReportQuerySchema, ReportTableSchema } from './schemas/reports'
import {
  CreateSuppressionSchema,
  DeliveryEventSchema,
  EmailLogSchema,
  SuppressionListSchema,
} from './schemas/email'
import { SupplierSchema, SupplierListSchema, CreateSupplierInputSchema, UpdateSupplierInputSchema } from './schemas/supplier'
import {
  SupplierProductSchema,
  SupplierProductListSchema,
  SupplierProductWithVariantListSchema,
  CreateSupplierProductInputSchema,
  UpdateSupplierProductInputSchema,
} from './schemas/supplierProduct'
import { ReorderSuggestionListSchema } from './schemas/reorder'
import {
  PurchaseOrderSchema,
  PurchaseOrderListSchema,
  CreatePurchaseOrderSchema,
  UpdatePurchaseOrderSchema,
  ReceivePurchaseOrderSchema,
  ReceiptResultSchema,
} from './schemas/purchaseOrder'
import {
  BillingPlanCatalogSchema,
  BillingStatusSchema,
  CancelSubscriptionSchema,
  CreateSubscriptionResponseSchema,
  CreateSubscriptionSchema,
  VerifySubscriptionSchema,
} from './schemas/billing'

// extendZodWithOpenApi(z) is NOT called here — `./schemas/auth.ts` already
// calls it exactly once at process load, and this file imports schemas from
// that module (transitively loading it first), so a second call against the
// same `zod` module instance would be redundant/unsafe. See that file's
// comment for the authoritative single-call-site note.

const registry = new OpenAPIRegistry()

registry.registerPath({
  method: 'get',
  path: '/billing/plans',
  description: 'Read the backend-owned subscription catalog for the authenticated tenant region. Provider Plan IDs are never sent to the browser.',
  request: { query: z.object({ region: z.enum(['IN', 'US']).optional() }) },
  responses: {
    200: { description: 'Subscription plan catalog', content: { 'application/json': { schema: BillingPlanCatalogSchema } } },
    400: { description: 'Region does not match the tenant account' },
    401: { description: 'Unauthenticated' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/billing/status',
  description: 'Read the server-owned subscription entitlement and provider references for the authenticated tenant.',
  responses: {
    200: { description: 'Subscription entitlement', content: { 'application/json': { schema: BillingStatusSchema } } },
    401: { description: 'Unauthenticated' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/billing/subscription',
  description: 'Create or recover one Razorpay Subscription using an application idempotency key. Owner-only.',
  request: { body: { content: { 'application/json': { schema: CreateSubscriptionSchema } } } },
  responses: {
    201: { description: 'Razorpay subscription ready for Checkout', content: { 'application/json': { schema: CreateSubscriptionResponseSchema } } },
    400: { description: 'Invalid plan or request' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    409: { description: 'Existing subscription or ended idempotency attempt' },
    503: { description: 'Provider or plan configuration is not ready' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/billing/subscription/verify',
  description: 'Verify the Razorpay Checkout signature and provider subscription state. Owner-only.',
  request: { body: { content: { 'application/json': { schema: VerifySubscriptionSchema } } } },
  responses: {
    200: { description: 'Verified subscription entitlement', content: { 'application/json': { schema: BillingStatusSchema } } },
    400: { description: 'Signature or subscription mismatch' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    503: { description: 'Provider status is not confirmed yet' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/billing/subscription/cancel',
  description: 'Schedule cancellation at the end of the current billing cycle. No immediate cancellation or refund is performed. Owner-only.',
  request: { body: { content: { 'application/json': { schema: CancelSubscriptionSchema } } } },
  responses: {
    200: { description: 'Cancellation scheduled', content: { 'application/json': { schema: BillingStatusSchema } } },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    404: { description: 'No subscription found' },
  },
})

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
  description: 'Complete onboarding once the required steps (business identity, tax profile) pass server validation. Owner-only.',
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
  path: '/auth/otp/request',
  description: "Send a 6-digit email OTP via Supabase Auth. Always responds 200 regardless of whether the account exists, to avoid leaking account existence. `purpose: 'signup'` lets Supabase create the Auth user on verification; `purpose: 'login'` does not.",
  request: {
    body: { content: { 'application/json': { schema: OtpRequestSchema } } },
  },
  responses: {
    200: { description: 'Code sent (if applicable)', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
    400: { description: 'Invalid request' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/owner-pin-recovery/request',
  description: 'Request a one-time email link to recover an owner counter PIN. Always returns the same success response for existing and non-existing accounts.',
  request: {
    body: { content: { 'application/json': { schema: OwnerPinRecoveryRequestSchema } } },
  },
  responses: {
    200: { description: 'Recovery email requested when applicable', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
    400: { description: 'Invalid email address' },
    502: { description: 'Recovery email provider unavailable' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/owner-pin-recovery/confirm',
  description: 'Use the authenticated Supabase recovery-link session to replace the current active owner\'s 4-digit counter PIN and revoke their active PIN sessions.',
  request: {
    body: { content: { 'application/json': { schema: SetPinSchema } } },
  },
  responses: {
    200: { description: 'Owner PIN recovered', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
    400: { description: 'Invalid PIN' },
    401: { description: 'Invalid or expired recovery link' },
    403: { description: 'Owner role required' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/signup',
  description: 'Real self-serve signup — verifies the emailed OTP (creating the Supabase Auth user if needed), then creates a tenants row with the full business/tax profile and an owner staff_members row.',
  request: {
    body: { content: { 'application/json': { schema: SignupSchema } } },
  },
  responses: {
    201: { description: 'Signup successful', content: { 'application/json': { schema: AuthResponseSchema } } },
    401: { description: 'Invalid or expired code' },
    409: { description: 'An account already exists with this email' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  description: 'Email+OTP login via Supabase Auth. Derives role/tenantId from the custom access token hook claims on the verified session.',
  request: {
    body: { content: { 'application/json': { schema: LoginSchema } } },
  },
  responses: {
    200: { description: 'Login successful', content: { 'application/json': { schema: AuthResponseSchema } } },
    401: { description: 'Invalid or expired code' },
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
  path: '/members',
  description: 'Create a local counter-only staff profile with a temporary four-digit PIN. Managers can create cashiers; owners can also create managers.',
  request: { body: { content: { 'application/json': { schema: CreateStaffSchema } } } },
  responses: {
    201: { description: 'Staff profile created', content: { 'application/json': { schema: MemberSchema } } },
    400: { description: 'Invalid staff details' },
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
  method: 'post',
  path: '/members/{memberId}/reset-pin',
  description: 'Reset a local staff PIN and force a personal PIN change at the next login. Manager+.',
  request: {
    params: z.object({ memberId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: ResetStaffPinSchema } } },
  },
  responses: {
    200: { description: 'PIN reset', content: { 'application/json': { schema: MemberSchema } } },
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
  path: '/terminal/pin/lock',
  description: 'Lock this browser as a shared register while keeping the organisation session connected.',
  responses: {
    200: { description: 'Register locked', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
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
    409: { description: 'The browser must be paired before a register or approval session can start' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/terminal/pin/change',
  description: 'Change the currently PIN-authenticated cashier\'s personal PIN after a temporary PIN login.',
  request: { body: { content: { 'application/json': { schema: ChangeOperatorPinSchema } } } },
  responses: {
    200: { description: 'PIN changed', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
    400: { description: 'Invalid PIN or operator session' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/terminal/pin/logout',
  description: 'End the current cashier session while keeping the organisation/device session connected.',
  responses: {
    200: { description: 'Operator session ended', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/terminal/pin/sessions',
  description: 'Manager/owner audit list of cashier login/logout sessions.',
  responses: {
    200: { description: 'Cashier sessions', content: { 'application/json': { schema: z.array(StaffSessionSchema) } } },
    403: { description: 'Insufficient permissions' },
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
  description: 'Resend a receipt email for a completed sale (CHECK-06) — uses the customer address on file for cashier requests, requires manager approval for a different address, and is rate limited.',
  request: {
    params: z.object({ saleId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: ResendReceiptInputSchema } } },
  },
  responses: {
    200: { description: 'Receipt sent', content: { 'application/json': { schema: ResendReceiptResponseSchema } } },
    400: { description: 'No email address available' },
    403: { description: 'A manager is required to change the recipient address' },
    404: { description: 'Sale not found' },
    429: { description: 'Receipt resend cooldown or tenant email budget exceeded' },
    502: { description: 'Email delivery failed' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/shifts',
  description: 'Shift history for the tenant, newest first, with staff and counter names resolved.',
  responses: {
    200: {
      description: 'Shift history',
      content: { 'application/json': { schema: z.array(ShiftHistoryEntrySchema) } },
    },
  },
})

registry.registerPath({
  method: 'get',
  path: '/shifts/current',
  description: 'Read the open shift for this paired counter. The result is counter-scoped, not cashier-scoped, so a cashier handover continues the same drawer shift.',
  responses: {
    200: { description: 'Current counter shift', content: { 'application/json': { schema: CurrentShiftSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/shifts',
  description: 'Open a shift with a starting cash count on a named counter (D-14, 0034). One counter holds at most one open shift.',
  request: { body: { content: { 'application/json': { schema: OpenShiftSchema } } } },
  responses: {
    201: { description: 'Shift opened', content: { 'application/json': { schema: ShiftSchema } } },
    404: { description: 'Counter not found' },
    409: { description: 'That counter already has an open shift, or is turned off' },
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
  path: '/variants/{variantId}/availability',
  description:
    "Where else in the business this variant is in stock (Phase 8). Open to EVERY role, cashiers included — a customer asking for blue when this shop is out is the reason a chain is worth running. Returns QUANTITY ONLY: another shop's sales, takings and shift figures stay scoped to the shop a person works in. Active shops only, own shop first, then fullest shelf first.",
  request: { params: z.object({ variantId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Per-shop availability',
      content: { 'application/json': { schema: VariantAvailabilitySchema } },
    },
    400: { description: 'Invalid variant id' },
    404: { description: 'Variant not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/stores',
  description:
    "The business's shops (Phase 8). An owner receives every store; a manager or cashier receives only their own, since they have no Stores module and no reason to enumerate the business's other outlets.",
  responses: {
    200: {
      description: 'Stores',
      content: { 'application/json': { schema: StoreListSchema } },
    },
  },
})

registry.registerPath({
  method: 'get',
  path: '/transfers',
  description: 'List transfers sent from or awaiting receipt at the active store. Manager or owner only.',
  responses: {
    200: { description: 'Store transfers', content: { 'application/json': { schema: StockTransferListSchema } } },
    403: { description: 'Manager or owner role required' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/transfers/destinations',
  description: 'List other active shops in this business that can receive stock from the active store.',
  responses: {
    200: { description: 'Transfer destinations', content: { 'application/json': { schema: TransferDestinationListSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/transfers',
  description: 'Send stock from the active store. The negative source ledger movements and transfer record commit atomically and are idempotent by clientTransferId.',
  request: { body: { content: { 'application/json': { schema: CreateStockTransferSchema } } } },
  responses: {
    201: { description: 'Transfer sent', content: { 'application/json': { schema: StockTransferSchema } } },
    400: { description: 'Invalid transfer' },
    404: { description: 'Store or variant not found' },
    409: { description: 'Insufficient stock' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/transfers/{transferId}/receive',
  description: 'Confirm the exact quantity that arrived at the active destination store. Positive destination movements and discrepancies commit atomically and are idempotent by clientReceiveId.',
  request: {
    params: z.object({ transferId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: ReceiveStockTransferSchema } } },
  },
  responses: {
    201: { description: 'Transfer received', content: { 'application/json': { schema: StockTransferSchema } } },
    400: { description: 'Every line must be counted exactly once' },
    404: { description: 'Transfer not found at this destination store' },
    409: { description: 'Transfer already received or not receivable' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/stores',
  description:
    'Open a new shop. Owner only — adding an outlet is a business decision and a billing event. Names are unique per business, case-insensitively.',
  request: { body: { content: { 'application/json': { schema: CreateStoreSchema } } } },
  responses: {
    201: { description: 'Store created', content: { 'application/json': { schema: StoreSchema } } },
    400: { description: 'Invalid request' },
    403: { description: 'Owner role required' },
    409: {
      description:
        'A store with that name already exists, or the plan\'s store allowance is used up (response carries storeAllowance and an upgrade message)',
    },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/stores/{storeId}',
  description:
    'Rename, re-address, retax or deactivate a shop. Owner only. Stores are deactivated rather than deleted because historical sales, shifts and Z reports must keep naming the shop they happened at, and a business must always retain at least one active store.',
  request: {
    params: z.object({ storeId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateStoreSchema } } },
  },
  responses: {
    200: { description: 'Store updated', content: { 'application/json': { schema: StoreSchema } } },
    400: { description: 'Invalid request' },
    403: { description: 'Owner role required' },
    404: { description: 'Store not found' },
    409: { description: 'Name taken, or this is the last active store' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/terminals',
  description: "The tenant's counters/tills. Readable by every role so a cashier can pick one when opening a shift.",
  responses: {
    200: { description: 'Terminals', content: { 'application/json': { schema: z.array(TerminalSchema) } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/terminals/device',
  description: 'Resolve the current browser/device pairing to a counter, if one exists.',
  responses: {
    200: {
      description: 'Current counter pairing',
      content: {
        'application/json': {
          schema: z.object({
            terminal: z.union([TerminalSchema, z.null()]),
            isRegisterLocked: z.boolean(),
          }),
        },
      },
    },
  },
})

registry.registerPath({
  method: 'post',
  path: '/terminals',
  description: 'Create a counter. Names are unique per tenant case-insensitively. Requires manager or owner role.',
  request: { body: { content: { 'application/json': { schema: CreateTerminalSchema } } } },
  responses: {
    201: { description: 'Terminal created', content: { 'application/json': { schema: TerminalSchema } } },
    400: { description: 'Invalid request' },
    409: { description: 'A counter with that name already exists' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/terminals/{terminalId}/pair',
  description: 'Pair or reassign this browser/device to a counter. Manager/owner only.',
  request: { params: z.object({ terminalId: z.string().uuid() }) },
  responses: {
    200: { description: 'Device paired', content: { 'application/json': { schema: TerminalSchema } } },
    404: { description: 'Counter not found' },
    409: { description: 'Counter is turned off' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/terminals/{terminalId}',
  description: 'Rename a counter or turn it on/off. A counter with a shift open on it cannot be turned off. Requires manager or owner role.',
  request: {
    params: z.object({ terminalId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateTerminalSchema } } },
  },
  responses: {
    200: { description: 'Terminal updated', content: { 'application/json': { schema: TerminalSchema } } },
    404: { description: 'Counter not found' },
    409: { description: 'Name already taken, or the counter has a shift open on it' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/terminals/{terminalId}',
  description: 'Delete a counter that has no shift history. Counters with history must be turned off instead so their Z reports keep naming them. Requires manager or owner role.',
  request: { params: z.object({ terminalId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Terminal deleted',
      content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
    },
    404: { description: 'Counter not found' },
    409: { description: 'Counter has shift history and cannot be deleted' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/categories',
  description: "The tenant's category list, with how many products sit in each.",
  responses: {
    200: {
      description: 'Categories',
      content: { 'application/json': { schema: z.array(CategorySchema) } },
    },
  },
})

registry.registerPath({
  method: 'post',
  path: '/categories',
  description: 'Create a category. Names are unique per tenant case-insensitively, so "Dairy" and "dairy" cannot both exist.',
  request: { body: { content: { 'application/json': { schema: CreateCategorySchema } } } },
  responses: {
    201: { description: 'Category created', content: { 'application/json': { schema: CategorySchema } } },
    400: { description: 'Invalid request' },
    409: { description: 'A category with that name already exists' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/categories/{categoryId}',
  description: 'Rename or reorder a category. A rename applies to every product in it at once.',
  request: {
    params: z.object({ categoryId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateCategorySchema } } },
  },
  responses: {
    200: { description: 'Category updated', content: { 'application/json': { schema: CategorySchema } } },
    404: { description: 'Category not found' },
    409: { description: 'A category with that name already exists' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/categories/{categoryId}',
  description: 'Delete a category. Products in it are NOT deleted — they become uncategorised.',
  request: { params: z.object({ categoryId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Category deleted',
      content: {
        'application/json': {
          schema: z.object({ deleted: z.boolean(), productsUncategorised: z.number().int() }),
        },
      },
    },
    404: { description: 'Category not found' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/categories/seed',
  description: 'Seed a starter category list for a business type. Additive and idempotent — existing names are skipped, never replaced.',
  request: { body: { content: { 'application/json': { schema: SeedCategoriesSchema } } } },
  responses: {
    200: {
      description: 'Categories seeded',
      content: {
        'application/json': {
          schema: z.object({ created: z.number().int(), categories: z.array(CategorySchema) }),
        },
      },
    },
    400: { description: 'Invalid request' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/notifications',
  description: 'Notifications for this tenant, newest first, with the unread count.',
  responses: {
    200: { description: 'Notifications', content: { 'application/json': { schema: NotificationListSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/notifications/read',
  description: 'Mark every currently-unread notification read. No per-item read state in V1.',
  responses: {
    200: { description: 'Marked read', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
  },
})

registry.registerPath({
  method: 'get',
  path: '/settings',
  description: 'Store settings — business identity, GST fields, tax rate and discount threshold. Readable by any staff role.',
  responses: {
    200: { description: 'Store settings', content: { 'application/json': { schema: StoreSettingsSchema } } },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/settings',
  description: 'Update store settings. Owner-only. Legal name/GSTIN/PAN are not amended with the government by this call — see UI copy.',
  request: { body: { content: { 'application/json': { schema: UpdateStoreSettingsSchema } } } },
  responses: {
    200: { description: 'Store settings updated', content: { 'application/json': { schema: StoreSettingsSchema } } },
    400: { description: 'Invalid request' },
    403: { description: 'Only the owner can change store settings' },
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
  path: '/suppliers/{supplierId}/products',
  description: "Every product this supplier is linked to, for the supplier detail page's Products supplied tab.",
  request: { params: z.object({ supplierId: z.string().uuid() }) },
  responses: {
    200: { description: 'Products supplied', content: { 'application/json': { schema: SupplierProductWithVariantListSchema } } },
    404: { description: 'Supplier not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/variants/{variantId}/supplier-products',
  description: 'List the suppliers this variant is bought from, primary first — each with its own lead time, cost, and min order qty.',
  request: { params: z.object({ variantId: z.string().uuid() }) },
  responses: {
    200: { description: 'Supplier products', content: { 'application/json': { schema: SupplierProductListSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/variants/{variantId}/supplier-products',
  description: 'Link a supplier to this variant with a product-specific lead time.',
  request: {
    params: z.object({ variantId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: CreateSupplierProductInputSchema } } },
  },
  responses: {
    201: { description: 'Supplier product created', content: { 'application/json': { schema: SupplierProductSchema } } },
    400: { description: 'Invalid request' },
    404: { description: 'Variant or supplier not found' },
    409: { description: 'This supplier is already linked to this variant' },
  },
})

registry.registerPath({
  method: 'patch',
  path: '/variants/{variantId}/supplier-products/{supplierProductId}',
  description: 'Edit a supplier product link, or flip isPrimary.',
  request: {
    params: z.object({ variantId: z.string().uuid(), supplierProductId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateSupplierProductInputSchema } } },
  },
  responses: {
    200: { description: 'Supplier product updated', content: { 'application/json': { schema: SupplierProductSchema } } },
    404: { description: 'Supplier product link not found' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/variants/{variantId}/supplier-products/{supplierProductId}',
  description: 'Unlink a supplier from this variant.',
  request: { params: z.object({ variantId: z.string().uuid(), supplierProductId: z.string().uuid() }) },
  responses: {
    204: { description: 'Supplier product removed' },
    404: { description: 'Supplier product link not found' },
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

registry.registerPath({
  method: 'post',
  path: '/import/uploads',
  description: 'Parse a catalog or sales CSV server-side and stage it for review. Writes nothing to the ledger. Owner-only.',
  request: { body: { content: { 'application/json': { schema: UploadImportSchema } } } },
  responses: {
    201: { description: 'File parsed and staged', content: { 'application/json': { schema: ImportBatchSchema } } },
    400: { description: 'The file could not be parsed' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    409: { description: 'This exact file has already been imported' },
    413: { description: 'File exceeds the size limit' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/import/batches',
  description: 'List recent imports for the authenticated tenant. Owner-only.',
  responses: {
    200: { description: 'Import history', content: { 'application/json': { schema: ImportBatchListSchema } } },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/import/batches/{id}',
  description: 'Read one staged or committed import, including its parsed preview. Owner-only.',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Import batch', content: { 'application/json': { schema: ImportBatchSchema } } },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    404: { description: 'No such import' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/import/batches/{id}/mapping-suggestion',
  description: 'ONBOARD-03: suggest source-column to target-field mappings. The suggestion is never persisted and never applied without owner confirmation. Owner-only.',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: 'Suggested mapping', content: { 'application/json': { schema: MappingSuggestionSchema } } },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    404: { description: 'No such import' },
    409: { description: 'That import has already been applied' },
    422: { description: 'The stored file can no longer be parsed' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/import/batches/{id}/commit',
  description: 'Apply the owner-confirmed mapping in one transaction. Imported sales are marked source=import and populate daily_sales_rollup. Owner-only.',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: CommitImportSchema } } },
  },
  responses: {
    200: { description: 'Import applied', content: { 'application/json': { schema: ImportCommitResultSchema } } },
    400: { description: 'The confirmed mapping is not usable' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    404: { description: 'No such import' },
    409: { description: 'That import has already been applied' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/reports/catalog',
  description: 'List the reports this store can run.',
  responses: {
    200: { description: 'Available reports', content: { 'application/json': { schema: ReportCatalogSchema } } },
    401: { description: 'Unauthenticated' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/reports',
  description: 'REPORT-01: run one report over a business-date range in the tenant timezone. Manager or owner.',
  request: { query: ReportQuerySchema },
  responses: {
    200: { description: 'Report table', content: { 'application/json': { schema: ReportTableSchema } } },
    400: { description: 'Unknown report or invalid range' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Manager or owner role required' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/email/log',
  description: 'COMMS-01: every email send attempt and its outcome. Manager or owner.',
  responses: {
    200: { description: 'Email send log', content: { 'application/json': { schema: EmailLogSchema } } },
    401: { description: 'Unauthenticated' },
    403: { description: 'Manager or owner role required' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/email/suppressions',
  description: 'Addresses this store no longer emails, and why. Manager or owner.',
  responses: {
    200: { description: 'Suppression list', content: { 'application/json': { schema: SuppressionListSchema } } },
    401: { description: 'Unauthenticated' },
    403: { description: 'Manager or owner role required' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/email/suppressions',
  description: 'Stop emailing an address. An unsubscribe suppresses offers only; a bounce or complaint suppresses everything. Owner-only.',
  request: { body: { content: { 'application/json': { schema: CreateSuppressionSchema } } } },
  responses: {
    201: { description: 'Address suppressed' },
    400: { description: 'Invalid address or reason' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
  },
})

registry.registerPath({
  method: 'delete',
  path: '/email/suppressions',
  description: 'Allow a suppressed address again. Owner-only.',
  request: { query: z.object({ email: z.string().email() }) },
  responses: {
    200: { description: 'Address allowed again' },
    400: { description: 'No address given' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
    404: { description: 'That address is not suppressed' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/email/events',
  description: 'Record a delivery, bounce or complaint from the email provider. A bounce or complaint also suppresses the address. Owner-only.',
  request: { body: { content: { 'application/json': { schema: DeliveryEventSchema } } } },
  responses: {
    200: { description: 'Event applied' },
    400: { description: 'Unreadable event' },
    401: { description: 'Unauthenticated' },
    403: { description: 'Owner role required' },
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
