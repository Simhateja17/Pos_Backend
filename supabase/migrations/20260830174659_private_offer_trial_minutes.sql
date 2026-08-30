alter table public.private_billing_offers
  add column if not exists trial_duration_minutes integer;

update public.private_billing_offers
set trial_duration_minutes = trial_days * 1440
where trial_duration_minutes is null;

alter table public.private_billing_offers
  alter column trial_duration_minutes set default 0,
  alter column trial_duration_minutes set not null;

alter table public.private_billing_offers
  drop constraint if exists private_billing_offers_trial_duration_minutes_check;

alter table public.private_billing_offers
  add constraint private_billing_offers_trial_duration_minutes_check
  check (trial_duration_minutes between 0 and 525600);

comment on column public.private_billing_offers.trial_duration_minutes is
  'Exact private-offer trial duration. Legacy trial_days remains populated for rolling-deploy compatibility.';
