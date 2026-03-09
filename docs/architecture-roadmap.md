# KiddBusy Architecture and Iteration Roadmap

Last updated: 2026-03-09

## 1) Product and Architecture Snapshot

KiddBusy is a static-site-first web app with serverless function extensions.

- Frontend: static HTML/CSS/JS (no framework, no build pipeline)
- Backend APIs: Netlify Functions (`netlify/functions/*.js`)
- Database: Supabase PostgreSQL via REST API
- File storage: Supabase Storage bucket (`listing-photos`)
- Hosting/deploy: Netlify (auto deploy from GitHub `main`)
- Source control: GitHub (`kiddbusyadmin/kiddbusy`)
- AI model: Anthropic (Claude) used in targeted functions
- Email: Resend used for transactional + compliant sends

Core philosophy to preserve: lightweight static pages + managed services.

## 2) Repository Layout (what matters most)

- `index.html`: public listing experience
- `admin.html`: command center dashboard + tabs + agent controls
- `owner.html`: owner claim and owner listing management portal
- `agent.html`: admin agent UI (legacy/in-progress)
- `netlify.toml`: function routes, schedules, and timeouts
- `netlify/functions/`: backend endpoints
- `supabase/migrations/`: DB schema migrations
- `scripts/run_required_migrations.sh`: applies required DB migrations in order
- `scripts/run_supabase_migration.sh`: migration runner utility
- `docs/`: feature-specific architecture notes

## 3) Frontend Surface Map

### Public (`index.html`)

Capabilities implemented:
- City/category discovery and listing cards
- Sponsored listing pinning at top tiles
- Review submission and display
- Share action with listing URL propagation
- Owner claim button (`/owner.html?listing_id=...`)
- Price pill display on tiles (`Free`, `$`, `$$`, `$$$`, `Unknown`)
- Listing title links to official business sites (no underline style)
- Photo display fallback logic: real photo when active, emoji when missing

### Admin (`admin.html`)

Tabs currently implemented:
- Dashboard
- Submissions
- Locations
- Photos
- Owner KPI
- CMO
- Agent Summary
- Cache
- Activity
- Integrity
- Agent

Notable dashboard behaviors:
- Top metrics honor shared time range selector (`24h`, `7d`, `30d`, `all`)
- Agent Summary tab shows plain-English logs with timestamps
- CMO tab stores and reads persistent execution mode (drafts vs auto-send)

### Owner (`owner.html`)

Owner workflow implemented:
1. Claim start (`owner_email`, code sent)
2. Verification code submit
3. Auto-approve if owner email domain matches listing website domain
4. Session token unlocks owner dashboard
5. Owner can update description/address/website and upload photo
6. Approved owner changes are applied and logged

## 4) Netlify Functions and Responsibilities

### Search and cache
- `search.js`: search API
- `daily-cache-warm.js`: scheduled cache warm

### Agent and orchestration
- `agent-proxy.js`: Anthropic proxy for agent UI
- `agent-scheduled.js`: scheduled autonomous admin routine
- `telegram-webhook.js`: agent interaction channel via Telegram
- `_agent-activity.js`: shared logger to `agent_activity`

### Admin data access and controls
- `db-proxy.js`: controlled admin read/write operations (moderation + agent activity queries)
- `cmo-config.js`: read/update CMO settings

### Email and compliance
- `send-email.js`: send endpoint routed through compliance helper
- `unsubscribe.js`: unsubscribe endpoint (`/unsubscribe`, `/api/unsubscribe`)
- `_email-compliance.js`: shared unsubscribe footer, suppression check, send log, headers

### Owner growth and claims
- `owner-leads-enrich.js`: Anthropic enrichment for preseed owner leads and website backfill
- `owner-claims.js`: claim verification and owner update workflows

### Photos
- `photo-admin.js`: photo pipeline admin API (`estimate_coverage`, queue/list jobs, candidates, submission photo moderation)

## 5) Routes and Schedules (`netlify.toml`)

Key API routes:
- `/api/search`
- `/api/warm`
- `/api/agent-run`
- `/api/photo-admin`
- `/api/owner-claims`
- `/api/owner-leads-enrich`
- `/api/cmo-config`
- `/api/unsubscribe`
- `/unsubscribe`

Scheduled jobs:
- `daily-cache-warm`: daily at 08:00 UTC
- `agent-scheduled`: daily at 14:00 UTC

## 6) Database Architecture

## Existing core tables (pre-existing in project)

Used extensively by app/admin/agents:
- `listings`
- `submissions`
- `reviews`
- `sponsorships`
- `email_leads`
- `analytics`

## Migration-managed extension tables

### Photo pipeline (`20260309_photo_pipeline.sql`)
- `listing_photos`
- `photo_ingestion_jobs`
- `submission_photos`
- Also extends `listings` with:
  - `photo_url`, `photo_source`, `photo_status`, attribution fields, dimensions, `photo_updated_at`

### Owner claims (`20260309_owner_claims.sql`)
- `owner_claims`
- `listing_owners`
- `owner_change_requests`

### Owner lead enrichment (`20260309_owner_leads_enrichment.sql`)
- `owner_marketing_leads`

### Email compliance (`20260309_email_unsubscribe.sql`)
- `email_preferences`
- `email_send_log`

### CMO settings (`20260309_cmo_agent_settings.sql`)
- `cmo_agent_settings` (singleton row id=1)

### Agent summary feed (`20260309_agent_activity.sql`)
- `agent_activity`

## 7) End-to-End Flows (critical)

### A) Submission -> moderation -> listing
1. Public submit in `index.html`
2. Row written to `submissions`
3. Admin reviews in `admin.html` -> `db-proxy`
4. Approved content reflected in listing inventory

### B) Owner claim -> owner-managed listing
1. User taps claim button on listing card
2. `owner.html` starts claim via `/api/owner-claims`
3. Email code sent via Resend
4. Verification checks code + domain match
5. Approved owner updates listing and can upload photo

### C) Photo moderation and publishing
1. Submission/owner image enters `submission_photos`
2. Admin moderates in Photos tab (`photo-admin` actions)
3. Approved image promoted to `listing_photos` active
4. `listings.photo_url` updated
5. Public cards render photo automatically

### D) CMO and agent operations
1. CMO settings edited in admin tab (`/api/cmo-config`)
2. Scheduled/operational agents run
3. Actions logged in `agent_activity`
4. Agent Summary tab displays plain-English timeline

### E) Email compliance
1. All sending paths route through `_email-compliance.js`
2. Unsubscribe links appended and headers set
3. Suppression checked against `email_preferences`
4. Send/suppression outcome logged in `email_send_log`

## 8) Tools, Integrations, and Their Use

- Supabase:
  - PostgreSQL data plane
  - REST API usage from both client and serverless functions
  - Storage bucket for listing photos
- Netlify:
  - static hosting
  - serverless functions
  - scheduled function execution
- Anthropic:
  - owner lead enrichment with web search tool
  - autonomous admin/agent workflows
- Resend:
  - verification and outreach email delivery
  - all sends wrapped with unsubscribe compliance
- GitHub:
  - source of truth and deployment trigger via `main`

## 9) Environment Variables to Maintain

Critical vars in Netlify (and local `.env` for ops scripts):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `EMAIL_UNSUBSCRIBE_SECRET` (recommended explicit value)
- `KB_DB_URL` / `KB_DB_SERVICE_KEY` (optional aliases)

Feature-specific optional vars:
- `OWNER_LEADS_MODEL`
- `OWNER_CLAIM_CODE_TTL_MINUTES`
- `OWNER_CLAIM_SESSION_DAYS`
- `OWNER_CLAIM_EXPOSE_CODE` (testing only)
- `PHOTO_UPLOAD_BUCKET`
- `PHOTO_UPLOAD_MAX_BYTES`
- `PHOTO_CANDIDATES_PER_LISTING`
- `PHOTO_PHOTOS_PER_LISTING`
- `PHOTO_PROVIDER_COST_PER_1000`
- `PHOTO_PROVIDER_ITEMS_PER_CALL`

## 10) Operational Runbooks

### Apply required DB migrations

Run:
```bash
./scripts/run_required_migrations.sh
```

### Run one migration

Run:
```bash
./scripts/run_supabase_migration.sh supabase/migrations/<file>.sql
```

### Safe website-backfill campaign (Anthropic-throttled)

Recommended profile:
- `dry_run=true`
- `auto_write=false`
- `limit=1-3` per call
- 10-20s pause between calls
- city-by-city waves

Reason: minimizes risk of Anthropic rate spikes and cost spikes while progressively filling `listings.website`.

## 11) Guardrails for Future Iteration

Do not regress these:
- Keep static-site-first architecture unless strong reason to change.
- Preserve unsubscribe compliance on every outbound send path.
- Keep claim flow route `/owner.html` intact.
- Keep sponsored pinning logic deterministic (top ordering).
- Keep owner email domain verification policy unless explicitly changed.
- Keep action logs in `agent_activity` for all future agents.

## 12) High-Value Next Iteration Opportunities

1. Add agent filters and severity chips in Agent Summary tab.
2. Add retry/backoff and failure-reason bucketing to owner lead enrichment.
3. Add migration/state health checks in admin for missing tables/columns.
4. Add role separation/auth hardening for admin/owner endpoints.
5. Add automated nightly website-backfill wave with hard spend/rate caps.

## 13) Current Repo Hygiene Notes

Local noise currently exists (not architecture-critical):
- `.DS_Store`
- `pydeps/`
- `pw-browsers/`
- `evidence/`

Recommendation: keep these ignored to avoid accidental commits.

---

This document is intended to be the baseline handoff for any future contributor or agent.
