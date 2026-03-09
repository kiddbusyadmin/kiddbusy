-- Email unsubscribe preferences + send log

create table if not exists public.email_preferences (
  email text primary key,
  unsubscribed boolean not null default false,
  unsubscribed_at timestamptz,
  source text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_preferences_unsubscribed on public.email_preferences(unsubscribed, updated_at desc);

create table if not exists public.email_send_log (
  id bigint generated always as identity primary key,
  to_email text not null,
  subject text,
  campaign_type text,
  status text not null,
  resend_id text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_send_log_to_email on public.email_send_log(to_email, created_at desc);
create index if not exists idx_email_send_log_status on public.email_send_log(status, created_at desc);
