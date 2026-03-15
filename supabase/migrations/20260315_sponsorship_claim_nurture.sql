-- Owner-claim nurture automation for sponsorships blocked on claim verification

create table if not exists public.sponsorship_claim_nurture (
  nurture_id bigserial primary key,
  sponsorship_id text not null,
  listing_id bigint,
  owner_email text not null,
  business_name text,
  city text,
  status text not null default 'active',
  block_reason text,
  source text not null default 'db_proxy',
  step integer not null default 0,
  send_count integer not null default 0,
  last_sent_at timestamptz,
  next_send_at timestamptz not null default now(),
  last_error text,
  resolved_reason text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sponsorship_claim_nurture
  drop constraint if exists sponsorship_claim_nurture_status_check;
alter table public.sponsorship_claim_nurture
  add constraint sponsorship_claim_nurture_status_check
  check (status in ('active', 'completed', 'stopped', 'error'));

create unique index if not exists uq_sponsorship_claim_nurture_sponsor_email
  on public.sponsorship_claim_nurture(sponsorship_id, owner_email);

create index if not exists idx_sponsorship_claim_nurture_due
  on public.sponsorship_claim_nurture(status, next_send_at);

create index if not exists idx_sponsorship_claim_nurture_sponsorship
  on public.sponsorship_claim_nurture(sponsorship_id, created_at desc);
