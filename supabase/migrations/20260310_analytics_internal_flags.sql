-- Segregate internal/test traffic from production analytics.
alter table if exists public.analytics
  add column if not exists is_internal boolean default false,
  add column if not exists source text,
  add column if not exists user_agent text,
  add column if not exists path text;

create index if not exists idx_analytics_is_internal_created_at
  on public.analytics (is_internal, created_at desc);
