-- Agent activity feed for admin dashboard summary tab

create table if not exists public.agent_activity (
  id bigserial primary key,
  agent_key text not null,
  summary text not null,
  status text not null default 'info',
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_activity_created_at on public.agent_activity(created_at desc);
create index if not exists idx_agent_activity_agent_key on public.agent_activity(agent_key, created_at desc);

