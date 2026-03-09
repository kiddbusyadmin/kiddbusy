alter table public.cmo_agent_settings
  add column if not exists blog_queue_target_per_day integer not null default 50;

alter table public.cmo_agent_settings
  add column if not exists blog_distribution_enabled boolean not null default true;

alter table public.cmo_agent_settings
  add column if not exists blog_publish_rate_per_day integer not null default 1;

alter table public.cmo_agent_settings
  drop constraint if exists cmo_blog_queue_target_per_day_check;

alter table public.cmo_agent_settings
  add constraint cmo_blog_queue_target_per_day_check check (blog_queue_target_per_day >= 1 and blog_queue_target_per_day <= 200);

alter table public.cmo_agent_settings
  drop constraint if exists cmo_blog_publish_rate_per_day_check;

alter table public.cmo_agent_settings
  add constraint cmo_blog_publish_rate_per_day_check check (blog_publish_rate_per_day >= 1 and blog_publish_rate_per_day <= 20);
