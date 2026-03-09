-- CMO agent settings + targets (singleton row)

create table if not exists public.cmo_agent_settings (
  id smallint primary key check (id = 1),
  primary_goal text not null default 'traffic',
  monthly_unique_visit_target integer not null default 1000,
  newsletter_signup_rate_target numeric(5,2) not null default 10.00,
  owner_claims_per_city_per_week integer not null default 1,
  sponsorship_revenue_target_monthly numeric(10,2) not null default 1000.00,
  audience_split jsonb not null default '{"parents_pct": 50, "owners_pct": 50}'::jsonb,
  channels jsonb not null default '["email","on_site_copy","social_drafts","owner_outreach","ad_landing_copy_tests"]'::jsonb,
  execution_mode text not null default 'drafts_for_approval' check (execution_mode in ('drafts_for_approval','auto_send_enabled')),
  auto_send_enabled boolean not null default false,
  email_streams jsonb not null default '["parent_newsletter_city","owner_claim_outreach","re_engagement","sponsorship_sales"]'::jsonb,
  monthly_email_send_cap integer not null default 3000,
  contact_cap integer not null default 1000,
  max_emails_per_day integer not null default 100,
  brand_voice text not null default 'playful_fun',
  personalization_fields jsonb not null default '["city","listing_viewed_shared","owner_claim_status","prior_open_click_behavior"]'::jsonb,
  kpi_priority jsonb not null default '["sessions","signup_conversion","sponsorship_lead_conversion","owner_claim_conversion","ctr"]'::jsonb,
  unsubscribe_rate_max numeric(5,2) not null default 5.00,
  run_cadence text not null default 'daily',
  hard_constraints jsonb not null default '["legal_compliance_limits","no_paid_ads","no_low_confidence_lead_outreach","no_copy_changes_without_approval"]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.cmo_agent_settings (id)
values (1)
on conflict (id) do nothing;

