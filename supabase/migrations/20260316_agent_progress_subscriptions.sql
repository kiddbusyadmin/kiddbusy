create table if not exists public.agent_progress_subscriptions (
  subscription_id bigserial primary key,
  owner_identity text not null default 'harold',
  agent_key text not null default 'president_agent',
  channel text not null default 'telegram',
  target_chat_id text,
  interval_minutes integer not null default 5,
  status text not null default 'active',
  scope text not null default 'all_open_orders',
  summary text,
  thread_key text,
  metadata jsonb not null default '{}'::jsonb,
  last_sent_at timestamptz,
  next_due_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_progress_subscriptions_owner_status
  on public.agent_progress_subscriptions(owner_identity, status, next_due_at desc);

create table if not exists public.agent_progress_reports (
  report_id bigserial primary key,
  subscription_id bigint references public.agent_progress_subscriptions(subscription_id) on delete cascade,
  owner_identity text not null default 'harold',
  agent_key text not null default 'president_agent',
  channel text not null default 'telegram',
  target_chat_id text,
  report_text text not null,
  report_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_progress_reports_subscription
  on public.agent_progress_reports(subscription_id, created_at desc);
