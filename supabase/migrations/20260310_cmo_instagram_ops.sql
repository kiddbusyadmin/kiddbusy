-- CMO Instagram operations settings + task queue

alter table public.cmo_agent_settings
  add column if not exists instagram_handle text,
  add column if not exists instagram_mode text not null default 'creator',
  add column if not exists instagram_profile_ready boolean not null default false,
  add column if not exists instagram_notifications_ready boolean not null default false,
  add column if not exists instagram_kickoff_posts_target integer not null default 3,
  add column if not exists instagram_daily_posts_target integer not null default 1;

alter table public.cmo_agent_settings
  drop constraint if exists cmo_agent_settings_instagram_mode_check;

alter table public.cmo_agent_settings
  add constraint cmo_agent_settings_instagram_mode_check
  check (instagram_mode in ('creator', 'business'));

create table if not exists public.cmo_social_tasks (
  task_id bigint generated always as identity primary key,
  task_key text not null unique,
  channel text not null default 'instagram',
  task_type text not null,
  status text not null default 'open',
  title text not null,
  instructions text,
  payload jsonb not null default '{}'::jsonb,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cmo_social_tasks
  drop constraint if exists cmo_social_tasks_status_check;

alter table public.cmo_social_tasks
  add constraint cmo_social_tasks_status_check
  check (status in ('open', 'completed', 'blocked', 'skipped'));

create index if not exists idx_cmo_social_tasks_channel_status_due on public.cmo_social_tasks(channel, status, due_at desc);
create index if not exists idx_cmo_social_tasks_created on public.cmo_social_tasks(created_at desc);

create or replace function public.set_updated_at_cmo_social_tasks()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_cmo_social_tasks_updated_at on public.cmo_social_tasks;
create trigger trg_cmo_social_tasks_updated_at
before update on public.cmo_social_tasks
for each row execute function public.set_updated_at_cmo_social_tasks();
