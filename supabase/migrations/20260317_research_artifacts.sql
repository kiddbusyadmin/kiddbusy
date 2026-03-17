create table if not exists public.research_artifacts (
  artifact_id bigserial primary key,
  owner_identity text not null default 'harold',
  task_id bigint unique references public.agent_tasks(task_id) on delete set null,
  order_id bigint references public.agent_orders(order_id) on delete set null,
  agent_key text not null default 'research_agent',
  question text not null,
  summary text,
  full_notes text,
  status text not null default 'open',
  confidence numeric(4,3),
  city text,
  tags jsonb not null default '[]'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_research_artifacts_agent_updated
  on public.research_artifacts(agent_key, updated_at desc);

create index if not exists idx_research_artifacts_owner_status
  on public.research_artifacts(owner_identity, status, updated_at desc);

create index if not exists idx_research_artifacts_city
  on public.research_artifacts(city, updated_at desc);

alter table public.research_artifacts
  drop constraint if exists research_artifacts_status_check;

alter table public.research_artifacts
  add constraint research_artifacts_status_check
  check (status in ('open', 'in_progress', 'completed', 'blocked', 'archived', 'superseded'));
