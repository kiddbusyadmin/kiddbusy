# Owner Leads Enrichment (Anthropic Web Search)

This pipeline researches pre-seeded listings and stores suspected owner outreach leads for claim-marketing campaigns.

## What it does

- Reads from `listings` where:
  - `status = active`
  - `source = preseed`
- Uses Anthropic web search to infer:
  - likely owner/contact name
  - likely contact email
  - phone, website
  - confidence score + evidence URLs
- Stores results in `owner_marketing_leads` with status `suspected`.
- Backfills `listings.website` when a trusted website is found and the listing website is blank.

## Required setup

1. Run SQL migration:
   - `supabase/migrations/20260309_owner_leads_enrichment.sql`
2. Deploy function:
   - `netlify/functions/owner-leads-enrich.js`
3. Verify env vars in Netlify:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - optional: `OWNER_LEADS_MODEL` (default `claude-sonnet-4-20250514`)

## API

`POST /api/owner-leads-enrich`
Header:
- `X-Requested-From: kiddbusy-hq`

Body:
```json
{
  "action": "enrich_preseed_owner_leads",
  "city": "Houston",
  "limit": 25,
  "min_confidence": 0.55,
  "dry_run": true,
  "auto_write": false
}
```

Notes:
- `auto_write` defaults to `true` (qualified leads are written).
- `dry_run` defaults to `false` unless explicitly set.
- `min_confidence` defaults to `0.65`.
- Use `dry_run: true` to preview candidates without DB writes.
- Use `auto_write: false` if you want dry-run behavior without setting `dry_run`.
- Rows without valid email are skipped.
- Website backfill can still happen even when no email is found.

## Suggested operating flow

1. Run `dry_run` by city.
2. Review confidence and evidence URLs.
3. Run write mode (`dry_run: false`) for acceptable confidence threshold.
4. Use `owner_marketing_leads` as source for outbound claim campaigns.
