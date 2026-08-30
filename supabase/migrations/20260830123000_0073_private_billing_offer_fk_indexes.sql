begin;

create index if not exists idx_private_billing_offers_created_by
  on public.private_billing_offers (created_by);
create index if not exists idx_billing_trials_private_offer
  on public.billing_trials (private_offer_id)
  where private_offer_id is not null;

commit;
