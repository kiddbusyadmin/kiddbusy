create table if not exists public.owner_contact_messages (
  message_id bigserial primary key,
  listing_id bigint,
  listing_name text,
  listing_city text,
  owner_name text,
  owner_email text not null,
  owner_phone text,
  subject text,
  message text not null,
  status text not null default 'new' check (status in ('new','read','resolved')),
  created_at timestamptz not null default now()
);

create index if not exists idx_owner_contact_messages_created_at on public.owner_contact_messages(created_at desc);
create index if not exists idx_owner_contact_messages_listing on public.owner_contact_messages(listing_id, created_at desc);
create index if not exists idx_owner_contact_messages_status on public.owner_contact_messages(status, created_at desc);
