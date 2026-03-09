# City Expansion Population Plan

## Scope Added
- Dropdown expanded by 5 additional cities in each U.S. state.
- Net new city targets: 250.

## Population Strategy
1. Phase 1 (Coverage baseline)
- Goal: 12 high-confidence listings per new city.
- Total new listings target: 3,000.
- Prioritize categories: parks, playgrounds, museums, libraries, indoor play.
- Source mix: AI-preseed + manual QA spot checks.

2. Phase 2 (Quality + trust)
- Goal: increase each new city to 20 listings.
- Additional listings target: 2,000 (5,000 cumulative).
- Add owner-claim prompts to top 5 listings per city.
- Start collecting user photos and reviews to replace AI-only surface.

3. Phase 3 (Commercial readiness)
- Goal: top 50 new cities reach 35+ listings each.
- Additional listings target: 750+.
- Enable city-level sponsorship outreach once city has:
  - >=25 listings
  - >=10 monthly shares
  - >=3 owner claim events

## Execution Workflow
1. City queue generation
- Build queue from newly added cities only.
- Rank by metro population and traffic potential.

2. Seeding run
- Use existing AI/location pipelines to generate draft listings in batches.
- Batch size recommendation: 10 cities/run to keep QA manageable.

3. Validation rules
- Deduplicate by business name + address + city.
- Require category, neighborhood/address, and website when available.
- Reject placeholders/test entries.

4. Publish + observe
- Publish city when it has at least 8 approved listings.
- Track in analytics: `city_search`, `share_click`, `claim_open`, `review_submit`.

5. Owner growth loop
- Run owner lead enrichment for new cities after publish.
- Feed leads to CMO outreach drafts.

## Suggested Cadence
- Weekly target: 30 cities seeded, 15 cities quality-reviewed, 10 cities moved to owner outreach.
- Monthly outcome target:
  - 120+ new-city listings approved
  - 40+ owner leads enriched
  - 10+ owner claim starts from new cities

## Command Center KPI Additions (recommended)
- New Cities Seeded (7d/30d/all)
- New Listings Approved from Expansion Cities
- Avg Listings per Expansion City
- Expansion City Share Rate
- Expansion City Owner Claim Start Rate

## Go/No-Go Gates
- Do not enable sponsorship sales for a city until baseline quality is met.
- Do not auto-outreach low-confidence owner leads.
- Keep unsubscribe compliance on all email workflows.
