# Owner Claims (KiddBusy)

This enables business owners to claim listings, verify by email code, and update listing details/photos.

## Deploy order

1. Run SQL migrations in Supabase:
   - `supabase/migrations/20260309_photo_pipeline.sql`
   - `supabase/migrations/20260309_owner_claims.sql`
2. Deploy Netlify site/functions.
3. Confirm Netlify env vars:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
   - optional: `OWNER_CLAIM_EXPOSE_CODE=true` (testing only)

## Endpoints

`POST /api/owner-claims` (`X-Requested-From: kiddbusy-owner`)

- `start_claim`
- `verify_claim`
- `get_session`
- `submit_update`
- `abandon_claim`
- `log_event`

## UI surfaces

- Public card claim button routes to `/owner.html?listing_id=...`
- `owner.html` supports:
  - claim start
  - code verification
  - owner update save (description/address/website/photo)
- `admin.html` includes:
  - `Photos` moderation queue
  - `Owner KPI` tab with claim funnel and abandon tracking
