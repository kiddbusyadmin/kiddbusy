#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MIGRATIONS=(
  "supabase/migrations/20260309_photo_pipeline.sql"
  "supabase/migrations/20260309_owner_claims.sql"
  "supabase/migrations/20260309_owner_leads_enrichment.sql"
  "supabase/migrations/20260309_email_unsubscribe.sql"
  "supabase/migrations/20260309_cmo_agent_settings.sql"
  "supabase/migrations/20260309_agent_activity.sql"
  "supabase/migrations/20260309_blog_posts.sql"
  "supabase/migrations/20260309_cmo_blog_queue_settings.sql"
  "supabase/migrations/20260309_owner_contact_messages.sql"
  "supabase/migrations/20260310_events_source_url.sql"
  "supabase/migrations/20260310_events_dates_and_ongoing.sql"
  "supabase/migrations/20260310_analytics_internal_flags.sql"
)

for m in "${MIGRATIONS[@]}"; do
  echo "Applying: $m"
  ./scripts/run_supabase_migration.sh "$m"
  echo
  sleep 1
done

echo "All required migrations completed."
