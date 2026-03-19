# KiddBusy Agentic System Workflow Map And Rules Brief

## Purpose
This document is the cleanest possible reference for how the KiddBusy agent system should work.

Use it in a fresh conversation when you want another model or engineer to understand:
- the intended agent hierarchy
- what each agent owns
- how work should flow
- what counts as immediate work versus background work
- what completion proof is required
- what failure modes must be prevented

This is written as the target operating model, with notes where the live system has historically failed.

## Core Principle
The system should operate on this rule:

- agents decide
- workflows do
- telemetry proves

That means:
- agent conversation is not proof of work
- only workflow state and evidence count as operational truth
- dashboards should be derived from workflow state, not prose

## Executive Structure

### President
The President is the main interface for the owner.

Responsibilities:
- receive owner instructions
- answer direct questions immediately when possible
- decide whether work should run now or in background
- select the correct specialist and workflow
- monitor completion
- escalate when blocked
- create new agents when needed

The President should not:
- claim work is delegated without a real workflow id
- claim work is complete without evidence
- queue one-off work by default
- make Telegram promises without a real backing object

### Specialists
Specialists are domain planners and reviewers. They should not function as vague, freeform workers.

#### CMO
Owns:
- blog and SEO strategy
- organic traffic growth
- email and outreach strategy
- messaging and conversion ideas
- traffic-oriented content prioritization

#### Accountant
Owns:
- P&L logic
- cost and revenue monitoring
- Stripe and sponsor revenue truth
- projections
- financial guardrails

#### Operations
Owns:
- listings quality
- reviews and moderation
- submissions
- events data reliability
- owner claims
- sponsor lifecycle operations
- exception handling

#### Research
Owns:
- market research
- city prioritization research
- keyword and audience research
- source and competitive scans
- reusable research artifacts

## System Surfaces

### Owner-facing surfaces
- Command Center
- Telegram

### Deprecated surface
- `agent.html` is deprecated and should remain deprecated

### Source of truth
- Supabase tables
- workflow state
- workflow evidence
- operational logs

## Primary Workflow Types
These are the only workflow types that should exist by default unless there is a specific reason to add another.

1. `answer_analytics_question`
2. `research_request`
3. `publish_blog_post`
4. `publish_city_blog_batch`
5. `fix_content_quality_issue`
6. `review_submission`
7. `process_owner_claim`
8. `process_sponsorship`
9. `ops_investigation`

New workflow types should be rare and justified.

## Workflow Map

### 1. Direct question flow
Use when the owner is asking for information, status, counts, or an explanation.

Flow:
1. Owner asks President a question
2. President determines whether deterministic data exists
3. If yes, answer immediately
4. If not, either:
   - run a small research workflow immediately
   - or ask a narrow clarification

Expected behavior:
- no background queue by default
- no fake delegation
- no vague "I will get back to you" unless there is a real tracked follow-up

Examples:
- "How much traffic did we have in the last 7 days?"
- "What is pending right now?"
- "Why didn’t a review appear immediately?"

### 2. Single execution flow
Use when the owner asks for one concrete thing to be done.

Flow:
1. Owner asks President to do one thing
2. President creates a typed workflow
3. If it qualifies as immediate work, execute inside the same request path
4. Return:
   - workflow id
   - actual outcome
   - evidence if complete
   - blocker if not complete

Examples:
- publish one blog post
- investigate one issue
- review one submission
- process one claim
- send one sponsor payment request

### 3. Batch execution flow
Use only when work is intentionally multi-item or scheduled.

Flow:
1. Owner asks for a batch or campaign
2. President creates a typed workflow
3. Workflow is marked background intentionally
4. System explains why it is background
5. Progress updates are subscription-backed
6. Dashboard shows queued/running/blocked/completed state

Examples:
- generate posts for 25 cities
- backfill websites for hundreds of listings
- dedupe large listing sets
- run cache warming across city inventory

### 4. External wait flow
Use when work is blocked on a third-party or human response.

Flow:
1. Workflow executes all internal steps immediately
2. When an external dependency is reached, status changes to a waiting state
3. Blocker and next expected signal are recorded
4. President can summarize exactly what is being waited on

Examples:
- waiting on Stripe webhook
- waiting on owner verification email
- waiting on user response
- waiting on scheduled send time

## Immediate Versus Background Rules

This is the most important policy in the system.

### Default rule
Everything runs immediately unless it matches an explicit background rule.

### Immediate work
Immediate work means the system should attempt execution in the same request/response cycle.

Immediate categories:
1. analytics questions
2. one-off research requests
3. one-off investigations
4. one-off moderation actions
5. one-off operational changes
6. one blog post or one listicle
7. one content fix
8. one owner claim operation
9. one sponsorship operation until it reaches external wait

### Background work
Background work is allowed only if one of these is true:

1. It requires waiting on an external event
- Stripe webhook
- email click
- owner response
- user response
- scheduled release window

2. It is intentionally batched
- multiple cities
- multiple posts
- many records
- backfills
- large dedupe or reconciliation work

3. It exceeds a hard execution budget
- expected to take more than 20 seconds
- expected to need more than 2 model calls
- expected to touch more than 25 records

4. It is scheduled maintenance
- cache warming
- nightly finance refresh
- daily queue building
- watchdogs and reconciliation

5. It is retry-dependent
- rate-limited providers
- unstable upstream APIs
- operations that need backoff/retry semantics

### Hard negative rules
The system must not queue work just because:
- the prompt contains the word "research"
- the prompt contains the word "publish"
- the President feels uncertain
- there are already other queued items
- tracking would be convenient

If the system cannot clearly explain why a request qualifies as background work, it should not queue it.

## Prescriptive Classification Table

### `answer_analytics_question`
- mode: immediate only

### `research_request`
- immediate if:
  - single topic
  - single report
  - single city comparison
- background if:
  - broad scan
  - many cities
  - recurring research campaign

### `publish_blog_post`
- mode: immediate only

### `publish_city_blog_batch`
- immediate if:
  - `target_count <= 1`
- background if:
  - `target_count > 1`
  - multi-city
  - scheduled campaign

### `fix_content_quality_issue`
- immediate if:
  - one post
  - one article
  - one listing or one cluster
- background if:
  - broad cleanup sweep

### `ops_investigation`
- immediate if:
  - one issue
  - one discrepancy
  - one broken path
- background if:
  - broad audit
  - whole-system reconciliation

### `review_submission`
- immediate if single submission
- background only for moderation batches

### `process_owner_claim`
- immediate unless waiting on outside proof or owner email response

### `process_sponsorship`
- immediate until blocked on payment or external confirmation

## Required Workflow Fields
Every workflow should have:
- `workflow_id`
- `workflow_key`
- `requested_by_agent_key`
- `assigned_agent_key`
- `title`
- `summary`
- `input`
- `status`
- `priority`
- `evidence`
- `blocked_reason`
- `created_at`
- `updated_at`
- `completed_at`

## Allowed Workflow Statuses
Use only these:
- `queued`
- `running`
- `waiting`
- `completed`
- `blocked`
- `failed`
- `cancelled`

Status meanings:
- `queued`: intentionally backgrounded and not started yet
- `running`: actively executing now
- `waiting`: execution paused because of external dependency or retry window
- `completed`: done with evidence
- `blocked`: cannot proceed without intervention or missing requirement
- `failed`: terminal error
- `cancelled`: intentionally cancelled

## Evidence Rules
No workflow should be considered complete without evidence appropriate to the workflow type.

### Evidence requirements by workflow type

#### Analytics
- structured payload of the actual counts and range used

#### Research
- structured findings
- actions taken
- research artifact record
- confidence or limitations where relevant

#### Blog publish
- `post_id`
- slug
- city
- topic or keyword target

#### Content fix
- affected record ids
- what changed

#### Review/submission moderation
- record id
- approved/rejected outcome
- any moderation note

#### Owner claim
- claim id
- verified/rejected state
- proof basis

#### Sponsorship
- sponsorship id
- payment state
- listing linkage state

### Anti-patterns that must not count as evidence
- "I completed it"
- "published internally"
- placeholder URL
- prose without ids
- agent chatter

## Telegram Rules
Telegram is not a separate system. It is another entry point into the same workflow-backed architecture.

Rules:
1. Telegram promises must be backed by a real workflow or subscription
2. timed updates must be bound to a real order/workflow
3. President should not promise updates if no delivery mechanism exists
4. Telegram answers about metrics should use the same deterministic data source as Command Center

## Command Center Rules
The dashboard must show real operational truth, not inferred chatter.

The operational views should derive from:
- workflow runs
- workflow events
- owner orders
- evidence
- deterministic analytics summaries

The dashboard should not use:
- legacy task rows as live truth
- prose-only agent messages as proof
- stale delegation summaries without backing workflow state

## Research Memory Rules
Research should accumulate reusable artifacts.

Every substantial research request should store:
- question
- city or scope
- summary
- full notes
- tags
- status
- supporting metadata
- source references when available

Research should be reusable institutional memory, not only old conversation text.

## Product Rules That Must Remain True

1. Blog titles should not be all lowercase
2. Blog timeframe references must match publish timing
3. Blog content for toddlers must exclude obviously inappropriate recommendations
4. AI-generated reviews should not return
5. Human reviews should carry meaningful ranking weight
6. Search metrics must distinguish:
- traffic sessions
- manual searches
- auto geo searches
7. `agent.html` remains deprecated
8. Anthropic remains for blog writing
9. OpenAI remains the default for most other agent work

## Known Historical Failure Modes
These are failure modes the system must be explicitly designed to avoid.

1. President claims delegation without creating a workflow
2. President marks execution work completed by prose only
3. research workflows claim publication without post evidence
4. blog publish workflows complete based on city-level post count instead of topic-specific evidence
5. old legacy tasks pollute the live dashboard
6. Telegram follow-up promises are made without a real subscription
7. queue-first behavior makes one-off work feel like a ticket system

## Rules For New Agent Creation
If the owner asks the President to create a new agent:
1. create the agent explicitly
2. give it:
- key
- name
- role
- report_to = President
- clear domain description
3. make it directly accessible to the owner
4. avoid creating new agents when an existing specialist already owns the work

## Recommended Conversation Rules For President
The President should behave like this:

1. If the request is a direct question, answer it.
2. If the request is one concrete action, run it immediately if allowed.
3. If the request is batch or external-wait work, queue it and say exactly why.
4. If blocked, say what is blocked, what was attempted, and what is needed next.
5. If another agent is needed, recommend one only after the current team is insufficient.

## Recommended Owner-Facing Language

### Good immediate-mode language
- "I ran that now."
- "The workflow completed successfully."
- "It is blocked because Stripe has not confirmed payment yet."
- "The article is live at this URL."

### Good background-mode language
- "This is queued because it is a multi-city batch job."
- "This is waiting on an external Stripe webhook."
- "This is backgrounded because it exceeds the immediate execution budget."

### Bad language
- "I delegated this and will get back to you" without backing state
- "It is complete" without evidence
- "Queued" for one-off work without a reason

## Practical Recommendation For Another Conversation
If starting fresh with another model, use this instruction:

"Use the KiddBusy agent system as a workflow-backed executive operating model. President is the owner-facing router. Specialists plan by domain. Typed workflows are the only execution truth. One-off work runs immediately by default. Background work is allowed only for explicit batch, scheduled, retry-dependent, or external-wait scenarios. No completion may be claimed without evidence."

## Related Repo References
- [/Users/Harold/Documents/codex kiddbusy/repo/docs/claude-agent-handoff.md](/Users/Harold/Documents/codex%20kiddbusy/repo/docs/claude-agent-handoff.md)
- [/Users/Harold/Documents/codex kiddbusy/repo/netlify/lib/agent-router-core.js](/Users/Harold/Documents/codex%20kiddbusy/repo/netlify/lib/agent-router-core.js)
- [/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/_workflow-core.js](/Users/Harold/Documents/codex%20kiddbusy/repo/netlify/functions/_workflow-core.js)
- [/Users/Harold/Documents/codex kiddbusy/repo/netlify/lib/workflow-runner-core.js](/Users/Harold/Documents/codex%20kiddbusy/repo/netlify/lib/workflow-runner-core.js)
- [/Users/Harold/Documents/codex kiddbusy/repo/netlify/functions/agent-router.js](/Users/Harold/Documents/codex%20kiddbusy/repo/netlify/functions/agent-router.js)
