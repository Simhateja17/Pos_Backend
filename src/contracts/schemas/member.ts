import { z } from 'zod'

// NOTE: extendZodWithOpenApi(z) is NOT called here — `./auth.ts` already calls
// it exactly once at process load (per that file's own comment), and this
// module is always imported alongside it (openapi.ts imports both). Calling
// it twice against the same `zod` module instance is unnecessary/unsafe.

export const MemberSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    role: z.enum(['owner', 'manager', 'cashier']),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('Member')

// Deliberate scope choice: inviting a new OWNER isn't a Phase 1 UI-SPEC
// surface (D-04's Settings -> Members page invites managers/cashiers only).
// Multiple owners per tenant (D-03) can still exist via a direct role change
// on an existing member (PATCH /members/:id/role, which does allow 'owner'),
// or is out of scope for the invite flow specifically.
export const InviteMemberSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1),
    role: z.enum(['manager', 'cashier']),
  })
  .openapi('InviteMemberRequest')

export const UpdateMemberRoleSchema = z
  .object({
    role: z.enum(['owner', 'manager', 'cashier']),
  })
  .openapi('UpdateMemberRoleRequest')

export type Member = z.infer<typeof MemberSchema>
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>
