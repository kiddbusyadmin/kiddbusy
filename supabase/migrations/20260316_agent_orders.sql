create table if not exists public.agent_orders (
  order_id bigserial primary key,
  owner_identity text not null default 'harold',
  thread_id bigint references public.agent_threads(thread_id) on delete set null,
  channel text not null,
  channel_thread_key text not null,
  requested_agent_key text not null default 'president_agent',
  title text not null,
  request_text text not null,
  status text not null default 'pending_assignment',
  summary text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_agent_orders_status on public.agent_orders(status, requested_agent_key, updated_at desc);
create index if not exists idx_agent_orders_thread on public.agent_orders(channel, channel_thread_key, created_at desc);
