# KiddBusy Photo Pipeline (Backend Foundation)

This backend supports replacing emoji thumbnails with real location photos while keeping rollout controlled.

## What this adds

- Database fields on `listings` for active photo state (`photo_url`, `photo_status`, attribution fields)
- `listing_photos` table for candidate photos and review outcomes
- `photo_ingestion_jobs` table for city-level backfill queues and cost assumptions
- `submission_photos` table for user/owner uploaded image moderation
- Netlify function `/.netlify/functions/photo-admin` (redirected as `/api/photo-admin`)

## 1) Apply SQL migration first

Run this file in Supabase SQL editor:

- `supabase/migrations/20260309_photo_pipeline.sql`

If this migration is not applied first, `photo-admin` write actions will fail with table/column missing errors.

## 2) Environment variables (Netlify)

These are optional tuning values for cost math and queue defaults:

- `PHOTO_CANDIDATES_PER_LISTING` (default `3`)
- `PHOTO_PHOTOS_PER_LISTING` (default `1`)
- `PHOTO_PROVIDER_COST_PER_1000` (default `5` USD)
- `PHOTO_PROVIDER_ITEMS_PER_CALL` (default `1`)

Existing required vars still apply:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Additional optional vars:

- `PHOTO_UPLOAD_BUCKET` (default `listing-photos`)
- `PHOTO_UPLOAD_MAX_BYTES` (default `6291456`)

## 3) API actions

All actions are `POST /api/photo-admin` with header:

- `x-requested-from: kiddbusy-hq`

### `estimate_coverage`

Use this before ingestion to estimate calls and cost.

```json
{
  "action": "estimate_coverage",
  "provider": "pexels",
  "cities": ["Houston", "Charlotte", "Raleigh"],
  "photos_per_listing": 1,
  "candidates_per_listing": 3,
  "provider_cost_per_1000": 5,
  "provider_items_per_call": 1
}
```

### `queue_backfill`

Queues one `photo_ingestion_jobs` row per city with assumptions and estimated cost.

```json
{
  "action": "queue_backfill",
  "provider": "pexels",
  "requested_by": "harold",
  "cities": ["Houston", "Charlotte"],
  "photos_per_listing": 1,
  "candidates_per_listing": 3,
  "provider_cost_per_1000": 5,
  "provider_items_per_call": 1
}
```

### `list_jobs`

```json
{
  "action": "list_jobs",
  "limit": 50
}
```

### `add_candidate`

Stores or updates a photo candidate for a listing.

```json
{
  "action": "add_candidate",
  "listing_id": 123,
  "provider": "pexels",
  "source_url": "https://example.com/photo.jpg",
  "cdn_url": "https://cdn.kiddbusy.com/listings/123/photo.jpg",
  "attribution_name": "Photographer Name",
  "attribution_url": "https://example.com/credit",
  "license": "provider-license",
  "width": 1600,
  "height": 900,
  "score": 0.94
}
```

### `list_candidates`

```json
{
  "action": "list_candidates",
  "listing_id": 123,
  "status": "candidate",
  "limit": 100
}
```

### `submit_submission_photo`

Used by `index.html` owner submission flow. Owner uploads are auto-approved; if the listing already exists, photo is auto-published to the listing card.

```json
{
  "action": "submit_submission_photo",
  "business_name": "Children's Museum Houston",
  "city": "Houston, TX",
  "is_owner": true,
  "submitter_name": "Owner Name",
  "submitter_email": "owner@example.com",
  "file_name": "museum-front.jpg",
  "mime_type": "image/jpeg",
  "file_base64": "<base64>"
}
```

### `list_submission_photos`

```json
{
  "action": "list_submission_photos",
  "status": "pending",
  "limit": 200
}
```

### `approve_submission_photo`

```json
{
  "action": "approve_submission_photo",
  "submission_photo_id": 42,
  "listing_id": 676
}
```

### `reject_submission_photo`

```json
{
  "action": "reject_submission_photo",
  "submission_photo_id": 42,
  "reason": "Not the business location"
}
```

### `approve_candidate`

Promotes one candidate to active and writes `listings.photo_url`.

```json
{
  "action": "approve_candidate",
  "photo_id": 999,
  "cdn_url": "https://cdn.kiddbusy.com/listings/123/photo.jpg",
  "attribution_name": "Photographer Name",
  "attribution_url": "https://example.com/credit"
}
```

### `reject_candidate`

```json
{
  "action": "reject_candidate",
  "photo_id": 999,
  "reason": "Incorrect venue"
}
```

## 4) Recommended rollout order

1. Run SQL migration.
2. Deploy this commit.
3. Call `estimate_coverage` for your finite city list.
4. Decide preload count by city based on estimate output.
5. Queue backfill jobs (`queue_backfill`) once provider choice is final.
6. Use Command Center `Photos` tab to approve/reject user-submitted images and link unmatched photos to listings.
7. `index.html` now renders `photo_url` when active and falls back to emoji when missing.
