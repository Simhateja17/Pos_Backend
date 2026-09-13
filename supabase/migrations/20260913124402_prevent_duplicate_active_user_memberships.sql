-- One Supabase Auth identity maps to one active POS membership. The access
-- token hook carries a single tenant_id, so allowing multiple active rows
-- makes tenant selection arbitrary and can attach billing checks to the wrong
-- business. Inactive rows remain as audit history and can still share a user.
create unique index uq_staff_members_one_active_membership_per_user
  on public.staff_members (user_id)
  where user_id is not null and is_active = true;
