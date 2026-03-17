create table if not exists public.agent_threads (
  thread_id bigserial primary key,
  channel text not null,
  channel_thread_key text not null,
  owner_identity text,
  active_agent_key text not null default 'president_agent',
  title text,
  status text not null default 'active',
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, channel_thread_key)
);

create index if not exists idx_agent_threads_active_agent on public.agent_threads(active_agent_key);
create index if not exists idx_agent_threads_last_message on public.agent_threads(last_message_at desc);

create table if not exists public.agent_messages (
  message_id bigserial primary key,
  thread_id bigint not null references public.agent_threads(thread_id) on delete cascade,
  agent_key text,
  role text not null,
  content text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_messages_thread_created on public.agent_messages(thread_id, created_at desc);

create table if not exists public.agent_memory (
  memory_id bigserial primary key,
  owner_identity text not null default 'harold',
  agent_key text not null default 'president_agent',
  memory_kind text not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_identity, agent_key, memory_kind, key)
);

create index if not exists idx_agent_memory_agent_kind on public.agent_memory(agent_key, memory_kind, updated_at desc);

create table if not exists public.agent_tasks (
  task_id bigserial primary key,
  owner_identity text not null default 'harold',
  requested_by_agent_key text not null default 'president_agent',
  assigned_agent_key text not null,
  title text not null,
  status text not null default 'open',
  priority text not null default 'normal',
  summary text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_agent_tasks_status on public.agent_tasks(status, assigned_agent_key, updated_at desc);

insert into public.agent_memory (owner_identity, agent_key, memory_kind, key, value, pinned)
values (
  'harold',
  'president_agent',
  'standing_brief',
  'operating_model',
  jsonb_build_object(
    'traffic_first', true,
    'delegation_default', true,
    'pushback_policy', 'warn_briefly_execute_by_default_only_block_on_hard_constraints',
    'blog_city_seed_policy', 'local_first_link_aware_search_intent_driven_no_thin_content'
  ),
  true
)
on conflict (owner_identity, agent_key, memory_kind, key)
do update set
  value = excluded.value,
  pinned = excluded.pinned,
  updated_at = now();
