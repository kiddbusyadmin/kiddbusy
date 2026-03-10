-- Paid sponsor banner placements by city
-- Supports upload, moderation, and public render of approved banners.

create table if not exists public.sponsor_banners (
  banner_id bigint generated always as identity primary key,
  sponsorship_id text,
  listing_id bigint,
  city text not null,
  business_name text,
  image_url text not null,
  click_url text,
  headline text,
  subheadline text,
  priority integer not null default 100,
  source text not null default 'admin_upload',
  mime_type text,
  file_size_bytes integer,
  status text not null default 'pending',
  submitted_by_name text,
  submitted_by_email text,
  notes text,
  rejected_reason text,
  reviewed_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sponsor_banners
  drop constraint if exists sponsor_banners_status_check;

alter table public.sponsor_banners
  add constraint sponsor_banners_status_check
  check (status in ('pending', 'approved', 'rejected', 'archived'));

create index if not exists idx_sponsor_banners_city_status on public.sponsor_banners(city, status);
create index if not exists idx_sponsor_banners_status_created on public.sponsor_banners(status, created_at desc);
create index if not exists idx_sponsor_banners_priority on public.sponsor_banners(priority, approved_at desc, created_at desc);

create or replace function public.set_updated_at_sponsor_banners()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_sponsor_banners_updated_at on public.sponsor_banners;
create trigger trg_sponsor_banners_updated_at
before update on public.sponsor_banners
for each row execute function public.set_updated_at_sponsor_banners();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sponsor-banners',
  'sponsor-banners',
  true,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;
