create table if not exists public.workflow_runs (
  workflow_id bigserial primary key,
  owner_identity text not null default 'harold',
  order_id bigint references public.agent_orders(order_id) on delete set null,
  thread_id bigint references public.agent_threads(thread_id) on delete set null,
  workflow_key text not null,
  requested_by_agent_key text not null default 'president_agent',
  assigned_agent_key text not null,
  title text not null,
  status text not null default 'queued',
  priority text not null default 'normal',
  summary text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  blocked_reason text,
  retry_count integer not null default 0,
  last_progress_at timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_workflow_runs_status
  on public.workflow_runs(status, assigned_agent_key, next_run_at asc, updated_at desc);

create index if not exists idx_workflow_runs_order
  on public.workflow_runs(order_id, status, updated_at desc);

create table if not exists public.workflow_events (
  workflow_event_id bigserial primary key,
  workflow_id bigint not null references public.workflow_runs(workflow_id) on delete cascade,
  event_type text not null,
  step_key text,
  status text not null default 'info',
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflow_events_workflow
  on public.workflow_events(workflow_id, created_at desc);
