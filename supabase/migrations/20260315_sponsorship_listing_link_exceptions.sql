-- Deterministic sponsorship -> listing linking and exception queue

alter table public.sponsorships
  add column if not exists listing_id bigint;

create index if not exists idx_sponsorships_listing_id
  on public.sponsorships(listing_id);

alter table public.stripe_events
  add column if not exists listing_id bigint;

create index if not exists idx_stripe_events_listing_id
  on public.stripe_events(listing_id, created_at desc);

create table if not exists public.sponsorship_link_exceptions (
  exception_id bigserial primary key,
  sponsorship_id text,
  stripe_event_id text,
  event_type text,
  listing_id bigint,
  business_name text,
  city text,
  issue_code text not null,
  issue_detail text,
  status text not null default 'open',
  resolution_note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

alter table public.sponsorship_link_exceptions
  drop constraint if exists sponsorship_link_exceptions_status_check;
alter table public.sponsorship_link_exceptions
  add constraint sponsorship_link_exceptions_status_check
  check (status in ('open', 'resolved', 'ignored'));

create index if not exists idx_sponsorship_link_exceptions_status_created
  on public.sponsorship_link_exceptions(status, created_at desc);
create index if not exists idx_sponsorship_link_exceptions_sponsorship
  on public.sponsorship_link_exceptions(sponsorship_id, created_at desc);
create index if not exists idx_sponsorship_link_exceptions_event
  on public.sponsorship_link_exceptions(stripe_event_id, created_at desc);
