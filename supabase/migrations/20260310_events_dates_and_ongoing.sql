-- Support ongoing and explicit date filtering for event cards.
alter table if exists public.events
  add column if not exists ongoing boolean default false,
  add column if not exists start_date date,
  add column if not exists end_date date;
