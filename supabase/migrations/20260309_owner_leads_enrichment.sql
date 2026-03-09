-- Owner marketing lead enrichment from web research (Anthropic)

create table if not exists public.owner_marketing_leads (
  lead_id bigint generated always as identity primary key,
  listing_id bigint not null references public.listings(listing_id) on delete cascade,
  listing_name text not null,
  city text,
  lead_name text,
  lead_email text,
  lead_phone text,
  business_website text,
  source_type text not null default 'anthropic_web_search',
  source_model text,
  confidence numeric(5,4),
  status text not null default 'suspected',
  outreach_stage text not null default 'uncontacted',
  evidence_urls jsonb not null default '[]'::jsonb,
  notes text,
  raw_response jsonb,
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id, lead_email)
);

alter table public.owner_marketing_leads
  drop constraint if exists owner_marketing_leads_status_check;

alter table public.owner_marketing_leads
  add constraint owner_marketing_leads_status_check
  check (status in ('suspected', 'verified', 'rejected', 'contacted'));

alter table public.owner_marketing_leads
  drop constraint if exists owner_marketing_leads_outreach_stage_check;

alter table public.owner_marketing_leads
  add constraint owner_marketing_leads_outreach_stage_check
  check (outreach_stage in ('uncontacted', 'queued', 'sent', 'responded', 'opted_out'));

create index if not exists idx_owner_marketing_leads_listing on public.owner_marketing_leads(listing_id);
create index if not exists idx_owner_marketing_leads_city on public.owner_marketing_leads(city);
create index if not exists idx_owner_marketing_leads_status on public.owner_marketing_leads(status, outreach_stage);
create index if not exists idx_owner_marketing_leads_email on public.owner_marketing_leads(lead_email);
