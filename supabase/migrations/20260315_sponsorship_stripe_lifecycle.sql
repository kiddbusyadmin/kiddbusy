-- Stripe-driven sponsorship lifecycle automation

alter table public.sponsorships
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_price_id text,
  add column if not exists approved_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists last_payment_at timestamptz,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists canceled_at timestamptz,
  add column if not exists payment_error text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.sponsorships
  drop constraint if exists sponsorship_status_check;
alter table public.sponsorships
  drop constraint if exists sponsorships_status_check;
alter table public.sponsorships
  drop constraint if exists sponsorships_status_valid;

alter table public.sponsorships
  add constraint sponsorships_status_check
  check (
    status in (
      'pending',
      'pending_review',
      'approved_awaiting_payment',
      'active',
      'past_due',
      'cancel_at_period_end',
      'cancelled',
      'rejected'
    )
  );

create index if not exists idx_sponsorships_status_created
  on public.sponsorships(status, created_at desc);
create index if not exists idx_sponsorships_stripe_customer
  on public.sponsorships(stripe_customer_id);
create index if not exists idx_sponsorships_stripe_subscription
  on public.sponsorships(stripe_subscription_id);
create index if not exists idx_sponsorships_stripe_checkout
  on public.sponsorships(stripe_checkout_session_id);

create table if not exists public.stripe_events (
  event_id text primary key,
  event_type text not null,
  sponsorship_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  processing_status text not null default 'received',
  processing_error text,
  created_at timestamptz not null default now()
);

alter table public.stripe_events
  drop constraint if exists stripe_events_processing_status_check;
alter table public.stripe_events
  add constraint stripe_events_processing_status_check
  check (processing_status in ('received', 'processed', 'ignored', 'error'));

create index if not exists idx_stripe_events_created
  on public.stripe_events(created_at desc);
create index if not exists idx_stripe_events_type_created
  on public.stripe_events(event_type, created_at desc);

