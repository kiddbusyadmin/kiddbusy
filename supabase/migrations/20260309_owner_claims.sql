-- KiddBusy owner claims and owner-managed listing edits

create table if not exists public.owner_claims (
  claim_id bigint generated always as identity primary key,
  listing_id bigint not null references public.listings(listing_id) on delete cascade,
  owner_name text,
  owner_email text not null,
  owner_phone text,
  status text not null default 'code_sent',
  verification_code text,
  code_expires_at timestamptz,
  verify_attempts integer not null default 0,
  last_attempt_at timestamptz,
  verified_at timestamptz,
  approved_at timestamptz,
  rejected_reason text,
  session_token text unique,
  session_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.owner_claims
  drop constraint if exists owner_claims_status_check;

alter table public.owner_claims
  add constraint owner_claims_status_check
  check (status in ('code_sent', 'verified', 'approved', 'pending_review', 'rejected', 'abandoned', 'expired'));

create index if not exists idx_owner_claims_listing_id on public.owner_claims(listing_id);
create index if not exists idx_owner_claims_status_created on public.owner_claims(status, created_at desc);
create index if not exists idx_owner_claims_owner_email on public.owner_claims(owner_email);

create table if not exists public.listing_owners (
  owner_id bigint generated always as identity primary key,
  listing_id bigint not null references public.listings(listing_id) on delete cascade,
  claim_id bigint references public.owner_claims(claim_id) on delete set null,
  owner_name text,
  owner_email text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id, owner_email)
);

alter table public.listing_owners
  drop constraint if exists listing_owners_status_check;

alter table public.listing_owners
  add constraint listing_owners_status_check
  check (status in ('active', 'revoked'));

create index if not exists idx_listing_owners_listing_id on public.listing_owners(listing_id);
create index if not exists idx_listing_owners_owner_email on public.listing_owners(owner_email);

create table if not exists public.owner_change_requests (
  request_id bigint generated always as identity primary key,
  listing_id bigint not null references public.listings(listing_id) on delete cascade,
  claim_id bigint references public.owner_claims(claim_id) on delete set null,
  owner_email text not null,
  change_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  review_notes text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.owner_change_requests
  drop constraint if exists owner_change_requests_status_check;

alter table public.owner_change_requests
  add constraint owner_change_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'auto_approved'));

create index if not exists idx_owner_changes_listing_id on public.owner_change_requests(listing_id);
create index if not exists idx_owner_changes_status_created on public.owner_change_requests(status, created_at desc);
