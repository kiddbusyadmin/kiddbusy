const { sendCompliantEmail } = require('./_email-compliance');
const { triggerSponsorshipPaymentRequestEmail } = require('./_sponsorship-payment-email');
const { buildFinanceSnapshot, upsertFinanceSnapshot, addManualEntry, sbFetch } = require('./_accounting-core');
const { getTrafficSummary, getActivitySummary } = require('./_analytics-core');
const { getAgentRegistry, createAgentDefinition, findAgent, normalizeKey } = require('./_agent-org');
const { logAgentActivity } = require('./_agent-activity');
const {
  getOrCreateThread,
  appendMessage,
  getRecentMessages,
  upsertMemory,
  getAgentMemories,
  createTask,
  getOpenTasks,
  createOwnerOrder,
  updateOwnerOrder,
  getOwnerOrders,
  createProgressSubscription,
  updateProgressSubscription,
  getProgressSubscriptions,
  getProgressReports,
  getResearchArchive
} = require('./_agent-memory');
const {
  createWorkflow,
  getWorkflows,
  projectWorkflowAsTask
} = require('./_workflow-core');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PRESIDENT_MODEL = process.env.PRESIDENT_AGENT_MODEL || process.env.TELEGRAM_AGENT_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_AGENT_MODEL = process.env.OPENAI_AGENT_MODEL || 'gpt-4.1-mini';

const PRESIDENT_CONTEXT_BRIEF = [
  'KiddBusy operating brief:',
  '- Business model: family-friendly activity and business directory for parents, city-by-city, with static HTML frontend, Netlify Functions backend, and Supabase data layer.',
  '- Your job as President: manage the whole business, synthesize specialist guidance, prioritize the highest-leverage work, and remember that traffic is the gating factor for monetization.',
  '- Traffic rule: until traffic is meaningful, owner claims and sponsorship sales are secondary to organic growth. Monetization strategy must stay traffic-aware.',
  '- Available specialist org today: President, CMO, Accountant, Operations, and Research. You can create more agents on demand, and newly created agents should report to President while remaining directly accessible to the owner.',
  '- Direct user access rule: the owner can speak to any agent directly, but President remains the default executive interface and should synthesize cross-functional recommendations.',
  '- Dashboard and Telegram parity: any datapoint visible in Command Center should be answerable through the agent stack. Telegram should behave as a direct line into the President-led org.',
  '- Listings/reviews/operations scope: operations covers submissions, approvals, reviews, sponsorship workflow state, listings quality, event reliability, and moderation queues.',
  '- Finance scope: Accountant tracks finance snapshots, projected revenue, costs, sponsor lifecycle state, and manual entries relevant to P&L.',
  '- Marketing scope: CMO owns traffic growth, SEO, blog strategy, organic content, owner outreach sequencing, and conversion lift.',
  '- Research scope: Research scouts activity trends, local patterns, and strategic content opportunities that can feed CMO and President planning.',
  '- AI/provider posture: Anthropic is primary where configured, with OpenAI fallback present in key paths. Do not assume a single model/provider is always available.',
  '- Email posture: operational and marketing emails exist with unsubscribe handling and logging. Respect compliance constraints and send volume limits.',
  '- Sponsorship posture: sponsorship requires verified ownership. Stripe lifecycle exists, but revenue recommendations must stay grounded in actual traffic.',
  '- Image/photo posture: listings can start with emoji, then approved or auto-approved owner/user photos can replace that on cards.',
  '- Human review posture: real human reviews should carry ranking weight and are strategically important. Placeholder AI reviews should not dominate once real reviews exist.',
  '- Search/analytics posture: internal traffic and auto-detected city searches should not be confused with genuine user demand when reporting metrics.',
  '- Agent creation rule: when the owner asks to create another agent, create it using the tool instead of only describing it. Give it a clear role, description, and report-to-President structure.',
  '- Execution behavior: default to figuring out how the current team of agents can complete the owner request. Coordinate before objecting. If capability is missing, suggest creating a new agent for review.',
  '- Pushback policy: do not be overly resistant. Briefly flag risk or constraints, but execute by default unless blocked by legal/compliance, missing access, or a hard business rule.',
  '- Memory policy: remember owner preferences, active initiatives, and open work. Use stored thread memory, tasks, and pinned memories to maintain continuity.',
  '- Delegation accountability policy: if delegated work is not progressing, President is responsible for noticing, retrying, rerouting, or escalating. The owner should not be the first person to discover that subagent work stalled.',
  '- Escalation policy: when a delegated order stalls, first try to unblock it using the current team. If it still remains blocked or repeatedly stalls, escalate to the owner with a concise explanation of what was attempted and what decision or access is needed.',
  'Approved blog seeding and city expansion methodology:',
  '- Blog content must be locally informed and useful, not generic filler. Writing quality matters more than volume.',
  '- The blog should support SEO for searches like toddler activities + city + state, weekend activities, rainy day ideas, and city hub intent.',
  '- The earlier low-quality generic posts are not the standard. Content should reference real local context and should be strong enough to rank credibly.',
  '- Blog posts should avoid giving away free advertising. References to private businesses should be limited carefully; free/public places are safer defaults unless there is an approved promotional reason.',
  '- City hub pages are strategic assets. For top cities, hubs should connect listings, events, and related blog posts with internal links.',
  '- When seeding a new city, the methodology is: identify target search intents for that city, use actual local context, generate city-specific posts and hub content, include state names explicitly, include relevant links when the database has them, and cross-link between posts, hubs, listings, and events.',
  '- Hub pages for top cities should render events on load using cached or freshly warmed event data, and should support internal linking back into listings and related posts.',
  '- Expansion rule: this methodology should be repeatable on demand for additional cities. Quality and locality are mandatory; generic copy should be treated as failure.',
  '- SEO priority rule: pursue queries that parents actually search for, especially city + toddler activities patterns, but do not recommend mismatched activities such as outdoor playgrounds for rainy-day intent unless justified.',
  '- Future city rollout rule: when asked to expand to more cities, preserve the same local, link-aware, cross-linked, search-intent-led process rather than bulk publishing thin pages.'
].join('\n');

async function dbQuery(table, params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(params.select || '*')}&limit=${Math.min(Math.max(Number(params.limit) || 100, 1), 1000)}`;
  if (params.eq) {
    for (const [col, val] of Object.entries(params.eq)) {
      url += `&${col}=eq.${encodeURIComponent(val)}`;
    }
  }
  if (params.order) {
    url += `&order=${encodeURIComponent(String(params.order.by || 'created_at'))}.${params.order.asc ? 'asc' : 'desc'}`;
  }
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB query failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : [];
}

async function dbUpdate(table, id, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(updates)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB update failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : [];
}

function extractAnthropicText(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('\n').trim();
}

function extractOpenAiText(data) {
  if (!data) return '';
  const out = [];
  if (typeof data.output_text === 'string') out.push(data.output_text);
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (typeof item.text === 'string') out.push(item.text);
      if (Array.isArray(item.content)) {
        for (const c of item.content) if (c && typeof c.text === 'string') out.push(c.text);
      }
    }
  }
  return out.join('\n').trim();
}

async function sendEmail(to, subject, body, fromName = 'KiddBusy') {
  return sendCompliantEmail({
    to,
    subject,
    body,
    fromName,
    campaignType: 'agent_router',
    allowSuppressedBypass: false
  });
}

async function queryDashboardStats(range = '24h', options = {}) {
  const safeRange = ['24h', '7d', '30d', 'all'].includes(String(range)) ? String(range) : '24h';
  const reviews = await dbQuery('reviews', { select: 'status,created_at', limit: 2000, order: { by: 'created_at', asc: false } });
  const submissions = await dbQuery('submissions', { select: 'status,created_at,city', limit: 2000, order: { by: 'created_at', asc: false } });
  return {
    ...(await getTrafficSummary({
      range: safeRange,
      includeInternal: !!options.includeInternal,
      includeBots: !!options.includeBots
    })),
    submissions_pending: submissions.filter((s) => s.status === 'pending').length,
    reviews_pending: reviews.filter((r) => r.status === 'pending').length
  };
}

async function executeTool(name, input = {}, context = {}) {
  switch (name) {
    case 'list_agents': {
      const registry = await getAgentRegistry();
      return { default_role: registry.default_role, agents: registry.agents };
    }
    case 'create_agent': {
      const created = await createAgentDefinition(input);
      return { success: true, agent: created.agent, registry: created.registry };
    }
    case 'create_agent_task': {
      const requestedBy = input.requested_by_agent_key || 'president_agent';
      if (String(requestedBy) === 'president_agent' && !input.force_legacy_task) {
        const guessedWorkflowKey = String((input.details || {}).workflow_key || '').trim() ||
          (String(input.assigned_agent_key || '') === 'research_agent' ? 'research_request' :
            /\b(blog|post|article|seo|title)\b/i.test(String(input.title || '') + ' ' + String(input.summary || '')) ? 'publish_city_blog_batch' :
              'ops_investigation');
        return executeTool('create_workflow', {
          owner_identity: input.owner_identity || 'harold',
          requested_by_agent_key: requestedBy,
          assigned_agent_key: input.assigned_agent_key,
          workflow_key: guessedWorkflowKey,
          title: input.title,
          summary: input.summary || '',
          priority: input.priority || 'normal',
          input: Object.assign({}, input.details || {}),
          details: Object.assign({}, input.details || {}),
          order_id: input.order_id || context.currentOrderId || null
        }, context);
      }
      const task = await createTask({
        ownerIdentity: input.owner_identity || 'harold',
        requestedByAgentKey: requestedBy,
        assignedAgentKey: input.assigned_agent_key,
        title: input.title,
        summary: input.summary || '',
        details: Object.assign({}, input.details || {}, {
          order_id: input.order_id || context.currentOrderId || null
        }),
        priority: input.priority || 'normal'
      });
      context.createdTaskCount = (context.createdTaskCount || 0) + 1;
      context.createdTasks = Array.isArray(context.createdTasks) ? context.createdTasks : [];
      context.createdTasks.push(task);
      if ((input.order_id || context.currentOrderId) && !context.orderUpdated) {
        await updateOwnerOrder({
          orderId: input.order_id || context.currentOrderId,
          status: 'delegated',
          summary: input.summary || task.title,
          details: { delegated_to: input.assigned_agent_key, task_id: task.task_id }
        });
        context.orderUpdated = true;
      }
      try {
        await logAgentActivity({
          agentKey: input.assigned_agent_key || 'unknown',
          status: 'info',
          summary: `New delegated task from President: ${String(task.title || 'Untitled task').slice(0, 240)}`,
          details: {
            task_id: task.task_id,
            order_id: (input.order_id || context.currentOrderId || null),
            requested_by_agent_key: input.requested_by_agent_key || 'president_agent',
            assigned_agent_key: input.assigned_agent_key || null,
            priority: input.priority || 'normal',
            task_summary: input.summary || ''
          }
        });
      } catch (_) {
        // Do not fail task creation if audit logging fails.
      }
      return { success: true, task };
    }
    case 'create_workflow': {
      const workflow = await createWorkflow({
        ownerIdentity: input.owner_identity || 'harold',
        orderId: input.order_id || context.currentOrderId || null,
        threadId: input.thread_id || null,
        workflowKey: input.workflow_key,
        requestedByAgentKey: input.requested_by_agent_key || 'president_agent',
        assignedAgentKey: input.assigned_agent_key,
        title: input.title,
        summary: input.summary || '',
        payload: input.input || {},
        details: Object.assign({}, input.details || {}, {
          order_id: input.order_id || context.currentOrderId || null
        }),
        priority: input.priority || 'normal'
      });
      context.createdWorkflowCount = (context.createdWorkflowCount || 0) + 1;
      context.createdWorkflows = Array.isArray(context.createdWorkflows) ? context.createdWorkflows : [];
      context.createdWorkflows.push(workflow);
      if ((input.order_id || context.currentOrderId) && !context.orderUpdated) {
        await updateOwnerOrder({
          orderId: input.order_id || context.currentOrderId,
          status: 'delegated',
          summary: input.summary || workflow.title,
          details: { workflow_id: workflow.workflow_id, workflow_key: workflow.workflow_key, delegated_to: input.assigned_agent_key }
        });
        context.orderUpdated = true;
      }
      try {
        await logAgentActivity({
          agentKey: input.assigned_agent_key || 'unknown',
          status: 'info',
          summary: `New typed workflow from President: ${String(workflow.title || 'Untitled workflow').slice(0, 240)}`,
          details: {
            workflow_id: workflow.workflow_id,
            workflow_key: workflow.workflow_key,
            order_id: (input.order_id || context.currentOrderId || null),
            assigned_agent_key: input.assigned_agent_key || null
          }
        });
      } catch (_) {}
      return { success: true, workflow };
    }
    case 'query_owner_orders': {
      const rows = await getOwnerOrders({
        ownerIdentity: input.owner_identity || 'harold',
        limit: input.limit || 50,
        status: input.status || ''
      });
      return { count: rows.length, orders: rows };
    }
    case 'update_owner_order': {
      const row = await updateOwnerOrder({
        orderId: input.order_id || context.currentOrderId,
        status: input.status || 'pending_assignment',
        summary: input.summary || null,
        details: input.details || null,
        completed: String(input.status || '').toLowerCase() === 'completed'
      });
      context.orderUpdated = true;
      return { success: true, order: row };
    }
    case 'query_agent_tasks': {
      const tasks = await getOpenTasks({ ownerIdentity: input.owner_identity || 'harold', limit: input.limit || 30 });
      const workflows = await getWorkflows({
        ownerIdentity: input.owner_identity || 'harold',
        status: 'open_or_in_progress',
        limit: input.limit || 30
      });
      const projected = workflows.map(projectWorkflowAsTask).filter(Boolean);
      return { count: projected.length + tasks.length, tasks: projected.concat(tasks) };
    }
    case 'query_workflows': {
      const workflows = await getWorkflows({
        ownerIdentity: input.owner_identity || 'harold',
        status: input.status || 'active',
        limit: input.limit || 30
      });
      return { count: workflows.length, workflows };
    }
    case 'create_progress_subscription': {
      const row = await createProgressSubscription({
        ownerIdentity: input.owner_identity || 'harold',
        agentKey: input.agent_key || 'president_agent',
        channel: input.channel || context.channel || 'telegram',
        targetChatId: input.target_chat_id || context.targetChatId || null,
        intervalMinutes: input.interval_minutes || 5,
        scope: input.scope || 'all_open_orders',
        summary: input.summary || null,
        threadKey: input.thread_key || context.threadKey || null,
        metadata: input.metadata || {}
      });
      return { success: true, subscription: row };
    }
    case 'query_progress_subscriptions': {
      const rows = await getProgressSubscriptions({
        ownerIdentity: input.owner_identity || 'harold',
        status: input.status || 'active',
        dueOnly: !!input.due_only,
        limit: input.limit || 30
      });
      return { count: rows.length, subscriptions: rows };
    }
    case 'update_progress_subscription': {
      const row = await updateProgressSubscription({
        subscriptionId: input.subscription_id,
        status: input.status || null,
        summary: input.summary || null,
        metadata: input.metadata || null,
        lastSentAt: input.last_sent_at || null,
        nextDueAt: input.next_due_at || null
      });
      return { success: true, subscription: row };
    }
    case 'query_progress_reports': {
      const rows = await getProgressReports({
        ownerIdentity: input.owner_identity || 'harold',
        limit: input.limit || 20
      });
      return { count: rows.length, reports: rows };
    }
    case 'query_research_artifacts': {
      const rows = await getResearchArchive({
        ownerIdentity: input.owner_identity || 'harold',
        agentKey: input.agent_key || '',
        status: input.status || '',
        city: input.city || '',
        limit: input.limit || 20
      });
      return { count: rows.length, artifacts: rows };
    }
    case 'store_agent_memory': {
      const row = await upsertMemory({
        ownerIdentity: input.owner_identity || 'harold',
        agentKey: input.agent_key || 'president_agent',
        memoryKind: input.memory_kind || 'working_memory',
        key: input.key,
        value: input.value || {},
        pinned: !!input.pinned
      });
      return { success: true, memory: row };
    }
    case 'query_agent_memory': {
      const rows = await getAgentMemories({
        ownerIdentity: input.owner_identity || 'harold',
        agentKey: input.agent_key || 'president_agent',
        limit: input.limit || 50
      });
      return { count: rows.length, memories: rows };
    }
    case 'query_submissions': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const rows = await dbQuery('submissions', { eq, limit: input.limit || 100, order: { by: 'created_at', asc: false } });
      return { count: rows.length, submissions: rows };
    }
    case 'query_reviews': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const rows = await dbQuery('reviews', { eq, limit: input.limit || 100, order: { by: 'created_at', asc: false } });
      return { count: rows.length, reviews: rows };
    }
    case 'query_sponsorships': {
      const eq = {};
      if (input.status && input.status !== 'all') eq.status = input.status;
      const rows = await dbQuery('sponsorships', { eq, limit: input.limit || 100, order: { by: 'created_at', asc: false } });
      return { count: rows.length, sponsorships: rows };
    }
    case 'query_listings': {
      const eq = {};
      if (input.status) eq.status = input.status;
      const rows = await dbQuery('listings', { eq, limit: input.limit || 200, order: { by: 'last_refreshed', asc: false } });
      return { count: rows.length, listings: rows };
    }
    case 'query_analytics': {
      const eq = {};
      if (input.event) eq.event = input.event;
      if (input.city) eq.city = input.city;
      const rows = await dbQuery('analytics', { eq, limit: input.limit || 500, order: { by: 'created_at', asc: false } });
      return { count: rows.length, analytics: rows };
    }
    case 'query_agent_activity': {
      const eq = {};
      if (input.agent_key) eq.agent_key = input.agent_key;
      if (input.status) eq.status = input.status;
      const rows = await dbQuery('agent_activity', { eq, limit: input.limit || 200, order: { by: 'created_at', asc: false } });
      return { count: rows.length, activities: rows };
    }
    case 'query_dashboard_stats':
      return queryDashboardStats(input.range || '24h', {
        includeInternal: !!input.include_internal,
        includeBots: !!input.include_bots
      });
    case 'query_activity_summary':
      return getActivitySummary({
        range: input.range || '24h',
        includeInternal: !!input.include_internal,
        includeBots: !!input.include_bots
      });
    case 'query_finance_snapshot':
      return { snapshot: await buildFinanceSnapshot() };
    case 'run_accountant_snapshot': {
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      return { success: true, snapshot };
    }
    case 'add_finance_manual_entry': {
      const entry = await addManualEntry({
        kind: input.kind,
        amount: input.amount,
        category: input.category,
        vendor: input.vendor,
        notes: input.notes,
        entry_date: input.entry_date,
        source: 'agent_router'
      });
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      return { success: true, entry, snapshot };
    }
    case 'query_cmo_settings': {
      const rows = await dbQuery('cmo_agent_settings', { eq: { id: 1 }, limit: 1 });
      return { config: rows[0] || null };
    }
    case 'update_submission_status': {
      const rows = await dbUpdate('submissions', input.id, { status: input.status });
      return { success: true, data: rows[0] || null };
    }
    case 'update_review_status': {
      const rows = await dbUpdate('reviews', input.id, { status: input.status });
      return { success: true, data: rows[0] || null };
    }
    case 'update_sponsorship_status': {
      const beforeRows = await dbQuery('sponsorships', { eq: { id: input.id }, limit: 1 });
      const before = beforeRows[0] || null;
      const rows = await dbUpdate('sponsorships', input.id, { status: input.status });
      let paymentEmail = null;
      if (String(input.status || '').toLowerCase() === 'approved_awaiting_payment' && before) {
        const prev = String(before.status || '').toLowerCase();
        if (prev !== 'approved_awaiting_payment' && prev !== 'active' && prev !== 'cancel_at_period_end') {
          paymentEmail = await triggerSponsorshipPaymentRequestEmail({
            sponsorship: Object.assign({}, before, { status: 'approved_awaiting_payment' }),
            activationSource: 'agent_router'
          });
        }
      }
      return { success: true, data: rows[0] || null, payment_email: paymentEmail };
    }
    case 'send_email': {
      await sendEmail(input.to, input.subject, input.body, input.from_name || 'KiddBusy');
      return { success: true, to: input.to };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function toolDefinitions() {
  return [
    { name: 'list_agents', description: 'List all available agents and who they report to.', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'create_agent', description: 'Create a new direct-access specialist agent that reports to the President.', input_schema: { type: 'object', properties: {
      key: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, report_to: { type: 'string' }, description: { type: 'string' }, system_prompt: { type: 'string' }
    }, required: ['name', 'description'] } },
    { name: 'create_workflow', description: 'Create a typed workflow for execution work. Prefer this over generic task creation when the owner request requires real follow-through.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, requested_by_agent_key: { type: 'string' }, assigned_agent_key: { type: 'string' }, workflow_key: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, priority: { type: 'string' }, input: { type: 'object' }, details: { type: 'object' }, order_id: { type: 'number' }
    }, required: ['assigned_agent_key', 'workflow_key', 'title'] } },
    { name: 'create_agent_task', description: 'Legacy generic task creation. Use only if a typed workflow genuinely does not fit.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, requested_by_agent_key: { type: 'string' }, assigned_agent_key: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, priority: { type: 'string' }, details: { type: 'object' }, order_id: { type: 'number' }
    }, required: ['assigned_agent_key', 'title'] } },
    { name: 'query_owner_orders', description: 'Query owner orders assigned to President so you can track held, delegated, and completed work.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'update_owner_order', description: 'Update the current owner order status. Use this to leave work pending_assignment, mark it delegated, or mark it completed if handled directly.', input_schema: { type: 'object', properties: {
      order_id: { type: 'number' }, status: { type: 'string', enum: ['pending_assignment', 'delegated', 'in_progress', 'completed', 'blocked'] }, summary: { type: 'string' }, details: { type: 'object' }
    }, required: ['status'] } },
    { name: 'query_agent_tasks', description: 'List open and in-progress agent tasks for continuity and delegation tracking.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'query_workflows', description: 'List typed workflows and their live statuses. Prefer this for execution tracking.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'create_progress_subscription', description: 'Create a recurring owner progress update feed, especially for Telegram updates every N minutes.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, agent_key: { type: 'string' }, channel: { type: 'string' }, target_chat_id: { type: 'string' }, interval_minutes: { type: 'number' }, scope: { type: 'string' }, summary: { type: 'string' }, thread_key: { type: 'string' }, metadata: { type: 'object' }
    }, required: [] } },
    { name: 'query_progress_subscriptions', description: 'List active or due progress update subscriptions for the owner.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, status: { type: 'string' }, due_only: { type: 'boolean' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'update_progress_subscription', description: 'Pause, resume, or refresh a progress update subscription.', input_schema: { type: 'object', properties: {
      subscription_id: { type: 'number' }, status: { type: 'string' }, summary: { type: 'string' }, metadata: { type: 'object' }, last_sent_at: { type: 'string' }, next_due_at: { type: 'string' }
    }, required: ['subscription_id'] } },
    { name: 'query_progress_reports', description: 'Read recent progress reports already delivered to the owner.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'query_research_artifacts', description: 'Read stored Research findings so past research can be reused instead of rediscovered.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, agent_key: { type: 'string' }, status: { type: 'string' }, city: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'store_agent_memory', description: 'Persist a durable memory, preference, decision, or standing directive for an agent.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, agent_key: { type: 'string' }, memory_kind: { type: 'string' }, key: { type: 'string' }, value: { type: 'object' }, pinned: { type: 'boolean' }
    }, required: ['key', 'value'] } },
    { name: 'query_agent_memory', description: 'Read durable memory entries for an agent, including owner preferences and prior decisions.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, agent_key: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'query_dashboard_stats', description: 'Get the dashboard traffic source-of-truth metrics for the requested time range. Returns sessions, manual searches, auto searches, search conversion, and excluded internal/bot counts. Prefer this over raw analytics when answering traffic questions.', input_schema: { type: 'object', properties: { range: { type: 'string', enum: ['24h', '7d', '30d', 'all'] }, include_internal: { type: 'boolean' }, include_bots: { type: 'boolean' } }, required: [] } },
    { name: 'query_activity_summary', description: 'Get the dashboard activity source-of-truth summary for the requested time range. Returns event totals, sessions, top events, top cities, and filtered rows. Prefer this over raw analytics when answering activity questions.', input_schema: { type: 'object', properties: { range: { type: 'string', enum: ['24h', '7d', '30d', 'all'] }, include_internal: { type: 'boolean' }, include_bots: { type: 'boolean' } }, required: [] } },
    { name: 'query_submissions', description: 'Query listing submissions.', input_schema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    { name: 'query_reviews', description: 'Query reviews.', input_schema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    { name: 'query_sponsorships', description: 'Query sponsorship records.', input_schema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    { name: 'query_listings', description: 'Query active listings.', input_schema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    { name: 'query_analytics', description: 'Query analytics events used in Command Center.', input_schema: { type: 'object', properties: { event: { type: 'string' }, city: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    { name: 'query_agent_activity', description: 'Query recent agent activity by agent key.', input_schema: { type: 'object', properties: { agent_key: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    { name: 'query_finance_snapshot', description: 'Get current financial snapshot.', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'run_accountant_snapshot', description: 'Refresh the accountant snapshot.', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'add_finance_manual_entry', description: 'Add a manual finance entry.', input_schema: { type: 'object', properties: { kind: { type: 'string' }, amount: { type: 'number' }, category: { type: 'string' }, vendor: { type: 'string' }, notes: { type: 'string' }, entry_date: { type: 'string' } }, required: ['kind', 'amount'] } },
    { name: 'query_cmo_settings', description: 'Read current CMO settings.', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'update_submission_status', description: 'Approve or reject a submission.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['id', 'status'] } },
    { name: 'update_review_status', description: 'Approve or reject a review.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['id', 'status'] } },
    { name: 'update_sponsorship_status', description: 'Update a sponsorship status.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'status'] } },
    { name: 'send_email', description: 'Send an email to a recipient.', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, from_name: { type: 'string' } }, required: ['to', 'subject', 'body'] } }
  ];
}

function buildSystemPrompt(agent, registry, channel) {
  const orgLines = (registry.agents || []).map((a) => {
    const report = a.report_to || 'none';
    return `- ${a.name} [${a.key}] role=${a.role} reports_to=${report} direct_access=${a.direct_access ? 'yes' : 'no'}`;
  }).join('\n');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const presidentRules = [
    'You are the President agent for KiddBusy.',
    'You are the default managing agent and the owner can also talk to specialists directly.',
    'When the user asks for a new agent, create it with the create_agent tool instead of just describing it.',
    'When responding as President, synthesize across CMO, Accountant, and Operations perspectives.',
    'When asked about traffic, sessions, searches, or activity, use query_dashboard_stats and query_activity_summary instead of reasoning from raw analytics rows or memory.',
    'Traffic growth is the first gate for monetization. Do not forget that low traffic weakens owner-claim and sponsorship monetization.',
    'Default to working through how your existing team can fulfill the request. Use typed workflows before pushback.',
    'If the current team cannot do it well, recommend a new agent and explain why in one short paragraph.',
    'Only refuse or block when there is a hard legal, compliance, access, or business-rule constraint.',
    'Every owner order should be tracked. For a new order, either create a typed workflow, leave it pending_assignment with a short reason, or mark it completed if you handled it directly.',
    'If you are intentionally holding work instead of assigning it right away, you must call update_owner_order with status pending_assignment and a concise summary of why it is being held. Do not leave held work implied only in prose.',
    'If the owner asks for recurring progress updates, especially on Telegram, create a real progress subscription using create_progress_subscription. Do not just promise future updates in prose.',
    'Do not create generic tasks for conversational follow-ups or questions that can be answered directly from tools. Use tools to answer directly whenever possible.',
    'Use create_workflow for execution. Reserve create_agent_task for unusual legacy cases only.'
  ].join(' ');
  const specialistRules = `You are ${agent.name} for KiddBusy. Stay within your specialty while still being practical. Report clearly to the President agent when useful.`;
  return [
    normalizeKey(agent.key) === 'president_agent' ? presidentRules : specialistRules,
    agent.system_prompt || '',
    normalizeKey(agent.key) === 'president_agent' ? PRESIDENT_CONTEXT_BRIEF : '',
    `Channel: ${channel}.`,
    'Use plain text, not markdown tables.',
    'Be concise, practical, and action-oriented.',
    'You have Command Center parity via tools.',
    'Before pushing back, assess whether President + current specialists can complete the request together.',
    'Current agent org:',
    orgLines,
    `Today: ${today}`
  ].join('\n\n');
}

function normalizeHistory(history) {
  return Array.isArray(history) ? history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content) : [];
}

async function runAnthropicLoop({ systemPrompt, history, userMessage }) {
  const messages = normalizeHistory(history).concat([{ role: 'user', content: userMessage }]);
  let working = messages.slice();
  let iterations = 0;
  while (iterations < 12) {
    iterations += 1;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: PRESIDENT_MODEL,
        max_tokens: 1400,
        temperature: 0.2,
        system: systemPrompt,
        tools: toolDefinitions(),
        messages: working
      })
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body && body.error && body.error.message) || `Anthropic HTTP ${res.status}`);
    if (body.stop_reason === 'tool_use') {
      const toolUses = (body.content || []).filter((c) => c && c.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUses) {
        let result;
        try {
          result = await executeTool(toolUse.name, toolUse.input || {});
        } catch (err) {
          result = { error: err.message || 'tool_failed' };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }
      working.push({ role: 'assistant', content: body.content });
      working.push({ role: 'user', content: toolResults });
      continue;
    }
    return extractAnthropicText(body);
  }
  throw new Error('Agent exceeded max iterations');
}

async function runOpenAiFallback({ systemPrompt, history, userMessage }) {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_AGENT_MODEL,
      input: [{ role: 'system', content: systemPrompt }].concat(
        normalizeHistory(history).concat([{ role: 'user', content: userMessage }]).map((m) => ({ role: m.role, content: m.content }))
      ),
      temperature: 0.2,
      max_output_tokens: 1200
    })
  });
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
  if (!res.ok) throw new Error((body && body.error && body.error.message) || `OpenAI HTTP ${res.status}`);
  return extractOpenAiText(body);
}

async function runOpenAiToolLoop({ systemPrompt, history, userMessage, execContext }) {
  let input = [{ role: 'system', content: systemPrompt }]
    .concat(normalizeHistory(history).map((m) => ({ role: m.role, content: m.content })))
    .concat([{ role: 'user', content: userMessage }]);
  let previousResponseId = null;
  let iterations = 0;
  while (iterations < 12) {
    iterations += 1;
    const payload = {
      model: OPENAI_AGENT_MODEL,
      input,
      temperature: 0.2,
      max_output_tokens: 1200,
      tools: toolDefinitions().map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }))
    };
    if (previousResponseId) payload.previous_response_id = previousResponseId;
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
    if (!res.ok) throw new Error((body && body.error && body.error.message) || `OpenAI HTTP ${res.status}`);
    previousResponseId = body && body.id ? body.id : previousResponseId;
    const outputs = Array.isArray(body && body.output) ? body.output : [];
    const calls = outputs.filter((item) => item && item.type === 'function_call');
    if (calls.length) {
      input = [];
      for (const call of calls) {
        let args = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch (_) {
          args = {};
        }
        let result;
        try {
          result = await executeTool(call.name, args, execContext);
        } catch (err) {
          result = { error: err.message || 'tool_failed' };
        }
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }
      continue;
    }
    return extractOpenAiText(body);
  }
  throw new Error('OpenAI agent exceeded max iterations');
}

function parseRoleHint(text, registry) {
  const raw = String(text || '').trim();
  const match = raw.match(/^\/([a-zA-Z0-9_]+)\b/);
  if (match) {
    const key = normalizeKey(match[1] === 'president' ? 'president_agent' : match[1] === 'accountant' ? 'accountant_agent' : match[1] === 'cmo' ? 'cmo_agent' : match[1] === 'ops' ? 'operations_agent' : match[1]);
    const agent = findAgent(registry, key);
    if (agent) return { role: agent.key, text: raw.replace(match[0], '').trim() || 'Give me a status update.' };
  }
  return null;
}

function summarizeThreadContext(messages) {
  const recent = (messages || []).slice(-8);
  if (!recent.length) return '';
  return recent.map((m) => `${m.role}${m.agent_key ? ':' + m.agent_key : ''}: ${String(m.content || '').slice(0, 240)}`).join('\n');
}

function inferRangeFromText(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(last|past)\s+24\s*(hours|hrs|h)\b|\b24h\b|\btoday\b/.test(raw)) return '24h';
  if (/\b(last|past)\s+7\s*(days|d)\b|\b7d\b|\bweek\b/.test(raw)) return '7d';
  if (/\b(last|past)\s+(30\s*days|month)\b|\b30d\b/.test(raw)) return '30d';
  if (/\ball time\b/.test(raw)) return 'all';
  return '24h';
}

function isDeterministicTrafficQuestion(text) {
  const raw = String(text || '').toLowerCase();
  if (!raw) return false;
  return /\btraffic\b|\bsessions?\b|\bmanual searches?\b|\bauto geo\b|\bauto searches?\b|\bactivity\b|\btop event\b|\btop city\b/.test(raw);
}

async function maybeBuildDeterministicAnalyticsReply(text) {
  if (!isDeterministicTrafficQuestion(text)) return null;
  const range = inferRangeFromText(text);
  const traffic = await getTrafficSummary({ range, includeInternal: false, includeBots: false });
  const activity = await getActivitySummary({ range: range === 'all' ? '24h' : range, includeInternal: false, includeBots: false });
  const label = range === '24h' ? 'last 24 hours' : range === '7d' ? 'last 7 days' : range === '30d' ? 'last 30 days' : 'all time';
  const lines = [];
  lines.push('For ' + label + ':');
  lines.push('Sessions: ' + String(traffic.sessions || 0));
  lines.push('Manual searches: ' + String(traffic.manual_searches || 0));
  lines.push('Auto geo searches: ' + String(traffic.auto_searches || 0));
  lines.push('Search conversion: ' + String(traffic.search_conversion_pct || 0) + '%');
  lines.push('Filtered out: ' + String(traffic.excluded_bots_in_range || 0) + ' bot rows and ' + String(traffic.excluded_internal_in_range || 0) + ' internal rows.');
  if (/\bactivity\b|\btop event\b|\btop city\b/.test(String(text || '').toLowerCase())) {
    lines.push('Top event: ' + String(((activity.top_event || {}).name) || '--') + ' (' + String(((activity.top_event || {}).count) || 0) + ')');
    lines.push('Top city: ' + String(((activity.top_city || {}).name) || '--') + ' (' + String(((activity.top_city || {}).count) || 0) + ')');
  }
  return lines.join('\n');
}

function inferCityFromRequest(text) {
  var raw = String(text || '').trim();
  var m = raw.match(/\b(?:for|in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s*[A-Z]{2})?\b/);
  if (m && m[1]) return String(m[1]).trim();
  return '';
}

function isLowSignalFollowUp(text) {
  var raw = String(text || '').trim().toLowerCase();
  if (!raw) return true;
  if (raw.length <= 6) return true;
  if (/^(yes|yeah|yep|no|nope|ok|okay|sure|proceed|continue|do it|done|thanks)\.?$/.test(raw)) return true;
  if (/^(is this done|what did [a-z ]+ say|how will i receive these confirmations of completed work)\??$/.test(raw)) return true;
  return false;
}

function shouldAutoDelegateExecutionRequest(text) {
  var raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  if (isLowSignalFollowUp(raw)) return false;
  return /\b(publish|write|create|generate|draft|post|launch|build|fix|review|approve|queue)\b/.test(raw);
}

function collectClaimedAgents(text) {
  var raw = String(text || '').toLowerCase();
  var out = {};
  if (!raw) return [];
  if (/\bcmo\b/.test(raw)) out.cmo_agent = true;
  if (/\boperations\b|\bops\b/.test(raw)) out.operations_agent = true;
  if (/\baccountant\b|\bfinance\b/.test(raw)) out.accountant_agent = true;
  if (/\bresearch\b/.test(raw)) out.research_agent = true;
  return Object.keys(out);
}

function buildAutoDelegationPlan(text, reply) {
  var raw = String(text || '').trim();
  var lower = raw.toLowerCase();
  if (isLowSignalFollowUp(lower)) return [];
  var replyText = String(reply || '').trim();
  var combinedClaimed = collectClaimedAgents(raw + '\n' + replyText);
  var isExecution = shouldAutoDelegateExecutionRequest(lower);
  if (!isExecution && !combinedClaimed.length) return [];
  var isResearchIntent = /\b(research|analyze|analysis|audit|investigate|identify|rank)\b/.test(lower);
  if (isResearchIntent) {
    return [{
      workflow_key: 'research_request',
      assigned_agent_key: 'research_agent',
      title: raw.slice(0, 180),
      summary: 'Auto-delegated by President because this request needs specialist research and a real deliverable.',
      input: {
        research_request: true,
        city: inferCityFromRequest(raw) || ''
      },
      details: {
        auto_delegated: true,
        research_request: true
      },
      priority: 'high'
    }];
  }
  if (/\b(blog|post|article|seo)\b/.test(lower)) {
    var city = inferCityFromRequest(raw);
    var isTitleFix = /\btitle|titles|capitalization|lowercase|formatting|style guide|style\b/.test(lower);
    var blogPlan = [{
      workflow_key: isTitleFix ? 'blog_title_qc' : 'publish_city_blog_batch',
      assigned_agent_key: 'cmo_agent',
      title: raw.slice(0, 180),
      summary: 'Auto-delegated by President because this was an execution request that needs real subagent work.',
      input: {
        city: city || '',
        article_count: 1,
        target_count: 1,
        seo_keyword_theme: /\bteen|teens|older kids|high school|middle school\b/.test(lower) ? 'local_teen' : 'local_toddler',
        title_qc: !!isTitleFix
      },
      details: {
        auto_delegated: true
      },
      priority: 'high'
    }];
    if (combinedClaimed.indexOf('operations_agent') >= 0) {
      blogPlan.push({
        workflow_key: isTitleFix ? 'blog_title_qc' : 'publish_city_blog_batch',
        assigned_agent_key: 'operations_agent',
        title: 'Publish handoff for ' + raw.slice(0, 150),
        summary: 'President promised Operations follow-through on this content request.',
        input: {
          city: city || '',
          article_count: 1,
          target_count: 1,
          seo_keyword_theme: /\bteen|teens|older kids|high school|middle school\b/.test(lower) ? 'local_teen' : 'local_toddler',
          title_qc: !!isTitleFix,
          dependent_on_agent_key: 'cmo_agent'
        },
        details: {
          auto_delegated: true,
          dependent_on_agent_key: 'cmo_agent'
        },
        priority: 'normal'
      });
    }
    return blogPlan;
  }

  return [{
    workflow_key: 'ops_investigation',
    assigned_agent_key: combinedClaimed[0] || 'operations_agent',
    title: raw.slice(0, 180),
    summary: 'Auto-delegated by President because this request needs typed execution follow-through.',
    input: {
      city: inferCityFromRequest(raw) || ''
    },
    details: {
      auto_delegated: true
    },
    priority: 'high'
  }];
}

async function ensurePresidentDelegation(text, reply, execContext) {
  var plan = buildAutoDelegationPlan(text, reply);
  if (!Array.isArray(plan) || !plan.length) return [];
  var created = [];
  var existingAgents = {};
  var current = Array.isArray(execContext.createdWorkflows) ? execContext.createdWorkflows : [];
  for (var i = 0; i < current.length; i += 1) {
    var row = current[i] && current[i].workflow ? current[i].workflow : current[i];
    var key = String((row && row.assigned_agent_key) || '').trim() + ':' + String((row && row.workflow_key) || '').trim();
    if (key) existingAgents[key] = true;
  }
  for (var p = 0; p < plan.length; p += 1) {
    var item = plan[p] || {};
    var assigned = String(item.assigned_agent_key || '').trim();
    var dedupeKey = assigned + ':' + String(item.workflow_key || '').trim();
    if (!assigned || existingAgents[dedupeKey]) continue;
    var result = await executeTool('create_workflow', {
      owner_identity: 'harold',
      requested_by_agent_key: 'president_agent',
      assigned_agent_key: assigned,
      workflow_key: item.workflow_key || 'ops_investigation',
      title: item.title || String(text || '').slice(0, 180),
      summary: item.summary || 'Auto-delegated by President.',
      input: Object.assign({}, item.input || {}),
      details: Object.assign({}, item.details || {}),
      priority: item.priority || 'high',
      order_id: execContext.currentOrderId || null
    }, execContext);
    created.push(result);
    existingAgents[dedupeKey] = true;
  }
  return created;
}

function appendTrackedDelegationSummary(reply, createdWorkflows) {
  var tasks = Array.isArray(createdWorkflows) ? createdWorkflows.filter(Boolean) : [];
  if (!tasks.length) return String(reply || '');
  var lines = [];
  var seen = {};
  for (var i = 0; i < tasks.length; i += 1) {
    var task = tasks[i] && tasks[i].workflow ? tasks[i].workflow : tasks[i];
    var key = String(task.assigned_agent_key || '') + ':' + String(task.workflow_id || '');
    if (seen[key]) continue;
    seen[key] = true;
    lines.push('- ' + String(task.assigned_agent_key || 'agent').replace(/_agent$/, '') + ' workflow #' + String(task.workflow_id || ''));
  }
  if (!lines.length) return String(reply || '');
  var footer = 'Tracked delegation:\n' + lines.join('\n');
  var base = String(reply || '').trim();
  if (base && base.indexOf(footer) >= 0) return base;
  return (base ? (base + '\n\n') : '') + footer;
}

function replyImpliesFollowUp(reply) {
  var text = String(reply || '').toLowerCase();
  if (!text) return false;
  return (
    /\bi(?:'|’)ll\s+(track|update|follow up|get back|report back|let you know)\b/.test(text) ||
    /\byou(?:'|’)ll\s+(hear from me|receive|get|see)\b/.test(text) ||
    /\bon telegram\b/.test(text) ||
    /\bonce [^.]{0,120}\b(delivers|finishes|completes)\b/.test(text)
  );
}

function textRequestsFollowUp(text) {
  var raw = String(text || '').toLowerCase();
  if (!raw) return false;
  return (
    /\b(get back to me|keep me posted|follow up|update me|let me know|report back)\b/.test(raw) ||
    (/\btelegram\b/.test(raw) && /\b(done|complete|finished|when it is done|when complete|once complete|once done)\b/.test(raw))
  );
}

async function ensureProgressFollowUp(reply, execContext) {
  if (!replyImpliesFollowUp(reply) && !textRequestsFollowUp(execContext.userMessage || '')) return null;
  if (execContext.progressSubscriptionId) return execContext.progressSubscriptionId;
  if (execContext.channel !== 'telegram') return null;
  if (!execContext.currentOrderId) return null;
  if (!Array.isArray(execContext.createdWorkflows) || !execContext.createdWorkflows.length) return null;
  var subResult = await executeTool('create_progress_subscription', {
    owner_identity: 'harold',
    agent_key: 'president_agent',
    channel: 'telegram',
    target_chat_id: execContext.targetChatId || null,
    interval_minutes: 15,
    scope: 'order_follow_up',
    summary: 'Auto-created because President promised a Telegram follow-up on delegated work.',
    thread_key: execContext.threadKey || null,
    metadata: {
      auto_created_from_reply: true,
      order_id: execContext.currentOrderId,
      workflow_ids: execContext.createdWorkflows.map(function(t) {
        var row = t && t.workflow ? t.workflow : t;
        return row && row.workflow_id;
      }).filter(Boolean),
      stop_when_order_complete: true
    }
  }, execContext);
  var sub = subResult && subResult.subscription;
  if (sub && sub.subscription_id) {
    execContext.progressSubscriptionId = sub.subscription_id;
    return sub.subscription_id;
  }
  return null;
}

function appendTrackedFollowUp(reply, subscriptionId) {
  if (!subscriptionId) return String(reply || '');
  var footer = 'Tracked follow-up: Telegram subscription #' + String(subscriptionId);
  var base = String(reply || '').trim();
  if (base.indexOf(footer) >= 0) return base;
  return (base ? (base + '\n\n') : '') + footer;
}

function sanitizeDelegationText(reply) {
  var lines = String(reply || '').split('\n');
  var out = [];
  var sawTrackedDelegation = false;
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (/^tracked delegation:/i.test(String(line || '').trim())) {
      if (sawTrackedDelegation) continue;
      sawTrackedDelegation = true;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function runAgentConversation({ role = '', userMessage = '', history = [], channel = 'dashboard', threadKey = '', ownerIdentity = 'harold' } = {}) {
  const registry = await getAgentRegistry();
  const hinted = parseRoleHint(userMessage, registry);
  const agent = findAgent(registry, hinted ? hinted.role : role || registry.default_role);
  if (!agent) throw new Error('No agent available');
  const text = hinted ? hinted.text : String(userMessage || '').trim();
  const resolvedThreadKey = String(threadKey || `${channel}:default`).trim();
  const thread = await getOrCreateThread({
    channel,
    channelThreadKey: resolvedThreadKey,
    ownerIdentity,
    activeAgentKey: agent.key
  });
  const storedMessages = await getRecentMessages(thread.thread_id, 24);
  const storedMemories = await getAgentMemories({ ownerIdentity, agentKey: 'president_agent', limit: 40 });
  const openTasks = await getOpenTasks({ ownerIdentity, limit: 20 });
  const openWorkflows = await getWorkflows({ ownerIdentity, status: 'active', limit: 20 });
  const openOrders = await getOwnerOrders({ ownerIdentity, limit: 20, status: 'open_funnel' });
  const researchArchive = await getResearchArchive({ ownerIdentity, limit: 8 });
  const threadSummary = summarizeThreadContext(storedMessages);
  const memorySummary = (storedMemories || []).map((m) => `- ${m.memory_kind}/${m.key}: ${JSON.stringify(m.value)}`).join('\n');
  const taskSummary = (openTasks || []).map((t) => `- ${t.assigned_agent_key}: ${t.title} [${t.status}]`).join('\n');
  const workflowSummary = (openWorkflows || []).map((w) => `- ${w.assigned_agent_key}: ${w.workflow_key} :: ${w.title} [${w.status}]`).join('\n');
  const orderSummary = (openOrders || []).map((o) => `- #${o.order_id} ${o.status}: ${o.title}`).join('\n');
  const researchSummary = (researchArchive || []).map((a) => `- ${a.question} [${a.status}]${a.city ? ' city=' + a.city : ''}`).join('\n');
  var currentOrder = null;
  if (agent.key === 'president_agent' && text) {
    currentOrder = await createOwnerOrder({
      ownerIdentity,
      threadId: thread.thread_id,
      channel,
      channelThreadKey: resolvedThreadKey,
      requestedAgentKey: 'president_agent',
      title: text.slice(0, 180),
      requestText: text,
      details: { source: channel }
    });
  }
  const systemPrompt = buildSystemPrompt(agent, registry, channel);
  const memoryBlock = [
    'Durable memory and continuity:',
    memorySummary || '- none recorded',
    'Open owner orders:',
    orderSummary || '- none recorded',
    'Open delegated tasks:',
    taskSummary || '- none recorded',
    'Open typed workflows:',
    workflowSummary || '- none recorded',
    'Recent research archive:',
    researchSummary || '- no stored research findings yet',
    'Recent thread context:',
    threadSummary || '- no prior thread history',
    currentOrder ? ('Current owner order id: ' + currentOrder.order_id) : 'Current owner order id: none'
  ].join('\n');
  let reply = '';
  let provider = '';
  const execContext = {
    currentOrderId: currentOrder ? currentOrder.order_id : null,
    createdTaskCount: 0,
    createdTasks: [],
    createdWorkflowCount: 0,
    createdWorkflows: [],
    orderUpdated: false,
    channel,
    threadKey: resolvedThreadKey,
    targetChatId: channel === 'telegram' ? (process.env.TELEGRAM_CHAT_ID || '') : '',
    userMessage: text
  };
  const deterministicAnalyticsReply = agent.key === 'president_agent'
    ? await maybeBuildDeterministicAnalyticsReply(text)
    : null;
  try {
    if (deterministicAnalyticsReply) {
      reply = deterministicAnalyticsReply;
      provider = 'deterministic_analytics';
    } else if (!ANTHROPIC_API_KEY) throw new Error('Anthropic not configured');
    else {
    reply = await (async function() {
      const messages = normalizeHistory(storedMessages.concat(normalizeHistory(history)));
      let working = messages.concat([{ role: 'user', content: text }]);
      let iterations = 0;
      while (iterations < 12) {
        iterations += 1;
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: PRESIDENT_MODEL,
            max_tokens: 1400,
            temperature: 0.2,
            system: `${systemPrompt}\n\n${memoryBlock}`,
            tools: toolDefinitions(),
            messages: working
          })
        });
        const body = await res.json();
        if (!res.ok) throw new Error((body && body.error && body.error.message) || `Anthropic HTTP ${res.status}`);
        if (body.stop_reason === 'tool_use') {
          const toolUses = (body.content || []).filter((c) => c && c.type === 'tool_use');
          const toolResults = [];
          for (const toolUse of toolUses) {
            let result;
            try {
              result = await executeTool(toolUse.name, toolUse.input || {}, execContext);
            } catch (err) {
              result = { error: err.message || 'tool_failed' };
            }
            toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
          }
          working.push({ role: 'assistant', content: body.content });
          working.push({ role: 'user', content: toolResults });
          continue;
        }
        return extractAnthropicText(body);
      }
      throw new Error('Agent exceeded max iterations');
    })();
    provider = 'anthropic';
    }
  } catch (primaryErr) {
    if (!OPENAI_API_KEY) throw primaryErr;
    if (deterministicAnalyticsReply) {
      reply = deterministicAnalyticsReply;
      provider = 'deterministic_analytics';
    } else {
      reply = await runOpenAiToolLoop({
        systemPrompt: `${systemPrompt}\n\n${memoryBlock}`,
        history: storedMessages.concat(normalizeHistory(history)),
        userMessage: text,
        execContext
      });
      provider = 'openai';
    }
  }
  if (currentOrder) {
    if (agent.key === 'president_agent') {
      try {
        await ensurePresidentDelegation(text, reply, execContext);
      } catch (_) {}
    }
    reply = sanitizeDelegationText(reply);
    if (execContext.createdWorkflowCount > 0 || execContext.createdTaskCount > 0) {
      try {
        var followUpId = await ensureProgressFollowUp(reply, execContext);
        if (followUpId) reply = appendTrackedFollowUp(reply, followUpId);
      } catch (followUpErr) {
        try {
          await logAgentActivity({
            agentKey: 'president_agent',
            status: 'error',
            summary: 'President failed to create promised Telegram follow-up subscription.',
            details: {
              order_id: currentOrder.order_id,
              thread_key: resolvedThreadKey,
              error: String((followUpErr && followUpErr.message) || followUpErr || 'unknown error').slice(0, 500)
            }
          });
        } catch (_) {}
      }
      reply = appendTrackedDelegationSummary(reply, execContext.createdWorkflows.length ? execContext.createdWorkflows : execContext.createdTasks);
      await updateOwnerOrder({
        orderId: currentOrder.order_id,
        status: 'delegated',
        summary: String(reply || '').slice(0, 600),
        details: {
          auto_status: execContext.createdWorkflows.length ? 'delegated_from_workflow_creation' : 'delegated_from_task_creation',
          workflow_ids: (execContext.createdWorkflows || []).map(function(t) {
            var row = t && t.workflow ? t.workflow : t;
            return row && row.workflow_id;
          }).filter(Boolean),
          task_ids: (execContext.createdTasks || []).map(function(t) { return t && t.task_id; }).filter(Boolean),
          delegated_agents: (execContext.createdWorkflows || []).map(function(t) {
            var row = t && t.workflow ? t.workflow : t;
            return row && row.assigned_agent_key;
          }).concat((execContext.createdTasks || []).map(function(t) { return t && t.assigned_agent_key; })).filter(Boolean)
        }
      });
    } else {
      await updateOwnerOrder({
        orderId: currentOrder.order_id,
        status: 'completed',
        summary: String(reply || '').slice(0, 600),
        details: { auto_status: 'completed_by_direct_response' },
        completed: true
      });
    }
  }
  await appendMessage({ threadId: thread.thread_id, role: 'user', content: text, agentKey: null, metadata: { channel, owner_identity: ownerIdentity } });
  await appendMessage({ threadId: thread.thread_id, role: 'assistant', content: reply, agentKey: agent.key, metadata: { provider, channel } });
  await upsertMemory({
    ownerIdentity,
    agentKey: 'president_agent',
    memoryKind: 'thread_summary',
    key: resolvedThreadKey,
    value: {
      last_user_request: text.slice(0, 600),
      last_agent: agent.key,
      last_reply: String(reply || '').slice(0, 1200),
      updated_at: new Date().toISOString()
    },
    pinned: false
  });
  await logAgentActivity({
    agentKey: agent.key,
    status: 'success',
    summary: `${agent.name} replied via ${provider}.`,
    details: {
      channel,
      provider,
      prompt_preview: text.slice(0, 240),
      thread_key: resolvedThreadKey
    }
  });
  return {
    success: true,
    role: agent.key,
    agent_name: agent.name,
    provider,
    reply,
    registry,
    thread_id: thread.thread_id,
    thread_key: resolvedThreadKey
  };
}

module.exports = {
  runAgentConversation,
  getAgentRegistry
};
