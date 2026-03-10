-- Add source URL support to cached events so event cards can link out.
alter table if exists public.events
  add column if not exists source_url text;

-- Optional index to speed city-scoped event reads.
create index if not exists idx_events_city_last_refreshed
  on public.events (city, last_refreshed desc);
