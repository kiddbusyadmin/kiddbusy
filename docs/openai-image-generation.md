# OpenAI Image Generation Integration

This project now supports OpenAI image generation via a Netlify function.

## Endpoint

- `POST /api/image-generate`
- Backed by: `netlify/functions/image-generate.js`
- Caller header required:
  - `X-Requested-From: kiddbusy-hq`
  - or `X-Requested-From: kiddbusy-agent`

## Purpose

Generate a listing image from OpenAI and publish it directly to:

- Supabase Storage bucket (`listing-photos`)
- `listing_photos` table (`provider='openai_image'`, `status='active'`)
- `listings.photo_url` + related photo fields

Existing active listing photos are set to `superseded` before the new image is marked active.

## Required Environment Variables

- `OPENAI_API_KEY` (required)
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (or KB aliases already used in project)

Optional:

- `OPENAI_IMAGE_MODEL` (default: `gpt-image-1`)
- `OPENAI_IMAGE_SIZE` (default: `1024x1024`)
- `OPENAI_IMAGE_QUALITY` (default: `medium`)
- `PHOTO_UPLOAD_BUCKET` (default: `listing-photos`)

## Request Body

```json
{
  "listing_id": 123,
  "prompt": "optional prompt override",
  "model": "optional model override",
  "size": "optional size override",
  "quality": "optional quality override"
}
```

- `listing_id` is required.
- If `prompt` is omitted, the function builds a safe default prompt from listing metadata.

## Example cURL

```bash
curl -sS -X POST "https://kiddbusy.com/api/image-generate" \
  -H "Content-Type: application/json" \
  -H "X-Requested-From: kiddbusy-hq" \
  --data '{"listing_id":123}'
```

## Response (success)

```json
{
  "success": true,
  "listing_id": 123,
  "prompt_used": "...",
  "model_used": "gpt-image-1",
  "uploaded_url": "https://.../storage/v1/object/public/listing-photos/...",
  "listing": { "...": "..." },
  "photo": { "...": "..." }
}
```
