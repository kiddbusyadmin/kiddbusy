-- Accountant agent data model (FinOps-style, reusable and minimal).

create table if not exists public.finance_settings (
  id integer primary key default 1 check (id = 1),
  default_monthly_api_cost numeric(10,2) not null default 0,
  default_monthly_subscription_cost numeric(10,2) not null default 0,
  churn_rate_monthly numeric(6,4) not null default 0.0500,
  growth_rate_monthly numeric(6,4) not null default 0.0800,
  updated_at timestamptz not null default now()
);

insert into public.finance_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.finance_manual_entries (
  id bigserial primary key,
  entry_date date not null default current_date,
  kind text not null check (kind in ('revenue', 'expense')),
  amount numeric(10,2) not null check (amount >= 0),
  category text not null default 'general',
  vendor text,
  notes text,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create index if not exists idx_finance_manual_entries_date on public.finance_manual_entries(entry_date desc);
create index if not exists idx_finance_manual_entries_kind on public.finance_manual_entries(kind, entry_date desc);

create table if not exists public.finance_snapshots (
  snapshot_date date primary key,
  active_sponsors integer not null default 0,
  cancelled_sponsors integer not null default 0,
  pending_sponsors integer not null default 0,
  mrr_active numeric(12,2) not null default 0,
  projected_revenue_30d numeric(12,2) not null default 0,
  api_cost_30d numeric(12,2) not null default 0,
  subscription_cost_30d numeric(12,2) not null default 0,
  manual_revenue_30d numeric(12,2) not null default 0,
  manual_expense_30d numeric(12,2) not null default 0,
  net_projection_30d numeric(12,2) not null default 0,
  details jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_finance_snapshots_updated_at on public.finance_snapshots(updated_at desc);
