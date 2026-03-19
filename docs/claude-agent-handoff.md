# Claude Code Handoff: KiddBusy Agent Orchestration Rebuild

## Objective
Replace the current custom KiddBusy agent orchestration with a reliable agent-runtime architecture while preserving the website, database, business rules, and dashboard integrations.

## Project Context
KiddBusy is a lean static site:
- Frontend: static HTML/CSS/JS
- Backend: Netlify Functions
- Database: Supabase
- Hosting: Netlify
- Source control: GitHub
- Payments: Stripe
- Email: Resend
- LLM policy:
  - Blog writing on Anthropic
  - Most other AI work on OpenAI

Repo:
- `kiddbusyadmin/kiddbusy`

Primary live interfaces for agents:
- Command Center: `admin.html`
- Telegram bot
- `agent.html` is deprecated and should stay deprecated

## Current Architectural Problem
The current custom orchestration layer is not trustworthy enough.

Observed failures:
1. President claims delegation without reliable execution evidence.
2. Chat, tasks, workflows, and status are blurred together.
3. Old `agent_tasks` created ghost open work.
4. Subagent progress has been inconsistent and hard to trust.
5. Dashboard truth was downstream of bad orchestration state.
6. Telegram follow-up promises were unreliable without explicit backing objects.

This created a system that can sound operational without being operational.

## What Must Be Preserved
1. President should remain the main executive interface.
2. Specialist roles should remain conceptually:
   - President
   - CMO
   - Accountant
   - Operations
   - Research
3. User should be able to talk:
   - to President by default
   - directly to specialists if desired
4. Command Center should continue to surface:
   - workflow state
   - business KPIs
   - plain-English summaries
5. Telegram should remain an important control surface.
6. Business truth must stay in Supabase, workflows, and app state, not in chat transcripts.

## Strong Recommendation For Rebuild
Use agents for planning and coordination, but use typed workflows for actual business execution.

Target model:
1. President
   - receives instructions
   - answers directly when possible
   - otherwise opens a typed workflow
   - never "delegates" in prose without a real workflow id
2. Specialist agents
   - planners/reviewers, not vague freeform workers
   - CMO: growth, blog, SEO, outreach
   - Accountant: revenue, costs, P&L, projections
   - Operations: claims, submissions, moderation, events, sponsor fulfillment
   - Research: market, city, and source research
3. Typed workflows
   - deterministic
   - stateful
   - evidence-backed
   - observable in dashboard
4. Dashboard telemetry
   - derived from workflow truth only
   - not from informal agent chatter

## Workflow Types To Support First
These are the priority typed workflows:
1. `answer_analytics_question`
2. `research_request`
3. `publish_blog_post`
4. `publish_blog_batch`
5. `fix_content_quality_issue`
6. `review_submission`
7. `process_owner_claim`
8. `process_sponsorship`
9. `ops_investigation`

## What Should Be Deprecated
These should no longer be the primary execution path:
1. Generic `agent_tasks` for new work
2. Freeform President delegation language without concrete backing state
3. Dashboard "open delegations" sourced from old task rows
4. "Office conversation" as source of operational truth

Old task and history data can remain for audit and history, but should be read-only and clearly legacy.

## Current Relevant Data And Infrastructure Already In Repo
There is already partial infrastructure for:
- agent threads and messages
- agent memory
- owner orders
- workflows
- analytics
- progress subscriptions
- command center tabs
- Telegram webhook
- blog generation
- research artifacts

Important files likely involved:
- `/Users/Harold/Documents/codex kiddbusy/repo/admin.html`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/lib/agent-router-core.js`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/_workflow-core.js`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/lib/workflow-runner-core.js`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/db-proxy.js`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/telegram-webhook.js`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/_cmo-blog-core.js`
- `/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/_analytics-core.js`

Relevant migrations already present:
- `supabase/migrations/20260316_agent_memory.sql`
- `supabase/migrations/20260316_agent_orders.sql`
- `supabase/migrations/20260317_agent_workflows.sql`
- `supabase/migrations/20260317_research_artifacts.sql`

## Non-Negotiable Product Rules
1. Blog titles should not be all lowercase.
2. Blog posts must have timeframe references that match publish date.
3. Blog quality must exclude obviously inappropriate toddler recommendations.
   - cemeteries
   - memorial grounds
   - nightlife
   - similar mismatches
4. AI-generated reviews have been removed and should stay removed.
5. Human-reviewed listings should rank above unrated ones where appropriate.
6. Search metrics must distinguish:
   - traffic sessions
   - manual searches
   - auto geo searches
7. Agent promises on Telegram should not be made unless backed by real state.
8. `agent.html` is deprecated and should stay retired.
9. Anthropic should remain for blog writing.
10. OpenAI should remain default for most other AI tasks.

## What Success Looks Like
For any new user instruction:
1. President either:
   - answers directly, or
   - creates a typed workflow, or
   - asks a necessary clarification
2. Every execution request gets:
   - workflow id
   - typed input
   - assigned owner or specialist
   - status
   - evidence on completion
3. Command Center shows only:
   - queued
   - running
   - blocked
   - completed
   - failed
   - escalated
4. Telegram updates are:
   - subscription-backed
   - workflow-backed
   - reliable
5. No more ghost open delegations.

## Desired UX
The owner wants:
- one managing agent: President
- specialists accessible directly
- President to coordinate the team by default
- if current specialists are insufficient, President may suggest creating a new agent
- plain-English office-style visibility is fine, but only as a presentation layer on top of real workflow state

## Migration Strategy Request
Please do the fastest reliable cutover, not incremental band-aids.

Preferred approach:
1. Freeze old task system for new writes.
2. Route all new President execution to typed workflows only.
3. Make dashboard read workflow truth only.
4. Keep legacy tables only for historical reference.
5. Preserve business logic and operational integrations already working in the rest of the app.

## Known Business Integrations
- Supabase
- Stripe
- Resend
- Netlify
- Telegram
- OpenAI API
- Anthropic API

## Final Request To Claude Code
Please take ownership of rebuilding the agent-runtime and orchestration layer.
Do not redesign the whole website.
Keep the business logic and operational integrations intact where possible.
The main need is a trustworthy executive-agent system with typed workflows and real completion evidence.
