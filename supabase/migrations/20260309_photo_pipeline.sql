-- KiddBusy photo pipeline foundation
-- Run this in Supabase SQL editor before enabling photo ingestion.

alter table public.listings
  add column if not exists photo_url text,
  add column if not exists photo_source text,
  add column if not exists photo_status text not null default 'none',
  add column if not exists photo_attribution_name text,
  add column if not exists photo_attribution_url text,
  add column if not exists photo_width integer,
  add column if not exists photo_height integer,
  add column if not exists photo_updated_at timestamptz;

alter table public.listings
  drop constraint if exists listings_photo_status_check;

alter table public.listings
  add constraint listings_photo_status_check
  check (photo_status in ('none', 'candidate', 'active', 'rejected'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'listings_listing_id_key'
      and conrelid = 'public.listings'::regclass
  ) then
    alter table public.listings
      add constraint listings_listing_id_key unique (listing_id);
  end if;
end $$;

create table if not exists public.listing_photos (
  photo_id bigint generated always as identity primary key,
  listing_id bigint not null references public.listings(listing_id) on delete cascade,
  provider text not null,
  source_url text not null,
  cdn_url text,
  status text not null default 'candidate',
  attribution_name text,
  attribution_url text,
  license text,
  width integer,
  height integer,
  score numeric(6,3),
  raw_payload jsonb,
  reviewed_at timestamptz,
  approved_at timestamptz,
  rejected_reason text,
  created_at timestamptz not null default now(),
  unique (listing_id, source_url)
);

alter table public.listing_photos
  drop constraint if exists listing_photos_status_check;

alter table public.listing_photos
  add constraint listing_photos_status_check
  check (status in ('candidate', 'active', 'rejected', 'superseded'));

create index if not exists idx_listing_photos_listing_id on public.listing_photos(listing_id);
create index if not exists idx_listing_photos_status on public.listing_photos(status);
create index if not exists idx_listing_photos_created_at on public.listing_photos(created_at desc);

create table if not exists public.photo_ingestion_jobs (
  job_id bigint generated always as identity primary key,
  city text not null,
  provider text not null,
  status text not null default 'queued',
  listings_target integer not null default 0,
  photos_per_listing integer not null default 1,
  candidates_per_listing integer not null default 3,
  estimated_calls integer not null default 0,
  estimated_cost_usd numeric(12,4) not null default 0,
  requested_by text,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.photo_ingestion_jobs
  drop constraint if exists photo_ingestion_jobs_status_check;

alter table public.photo_ingestion_jobs
  add constraint photo_ingestion_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'));

create index if not exists idx_photo_jobs_status_created on public.photo_ingestion_jobs(status, created_at desc);
create index if not exists idx_photo_jobs_city_created on public.photo_ingestion_jobs(city, created_at desc);

create table if not exists public.submission_photos (
  submission_photo_id bigint generated always as identity primary key,
  listing_id bigint references public.listings(listing_id) on delete set null,
  business_name text not null,
  city text not null,
  submitter_name text,
  submitter_email text,
  source_url text not null,
  provider text not null default 'owner_upload',
  mime_type text,
  file_size_bytes integer,
  is_owner boolean not null default false,
  status text not null default 'pending',
  notes text,
  rejected_reason text,
  reviewed_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.submission_photos
  drop constraint if exists submission_photos_status_check;

alter table public.submission_photos
  add constraint submission_photos_status_check
  check (status in ('pending', 'auto_approved', 'approved', 'rejected'));

create index if not exists idx_submission_photos_status_created on public.submission_photos(status, created_at desc);
create index if not exists idx_submission_photos_listing_id on public.submission_photos(listing_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-photos',
  'listing-photos',
  true,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;
