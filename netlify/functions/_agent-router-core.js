const { sendCompliantEmail } = require('./_email-compliance');
const { triggerSponsorshipPaymentRequestEmail } = require('./_sponsorship-payment-email');
const { buildFinanceSnapshot, upsertFinanceSnapshot, addManualEntry, sbFetch } = require('./_accounting-core');
const { getAgentRegistry, createAgentDefinition, findAgent, normalizeKey } = require('./_agent-org');
const { logAgentActivity } = require('./_agent-activity');
const {
  getOrCreateThread,
  appendMessage,
  getRecentMessages,
  upsertMemory,
  getAgentMemories,
  createTask,
  getOpenTasks
} = require('./_agent-memory');

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

async function queryDashboardStats(range = '24h') {
  const safeRange = ['24h', '7d', '30d', 'all'].includes(String(range)) ? String(range) : '24h';
  const events = await dbQuery('analytics', { select: 'event,city,created_at,session_id,source,is_internal', limit: 4000, order: { by: 'created_at', asc: false } });
  const reviews = await dbQuery('reviews', { select: 'status,created_at', limit: 2000, order: { by: 'created_at', asc: false } });
  const submissions = await dbQuery('submissions', { select: 'status,created_at,city', limit: 2000, order: { by: 'created_at', asc: false } });
  const now = Date.now();
  const ranges = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
  const scoped = safeRange === 'all' ? events : events.filter((row) => {
    const ms = new Date(row.created_at).getTime();
    return Number.isFinite(ms) && (now - ms) <= ranges[safeRange] * 60 * 60 * 1000;
  });
  const searchScoped = scoped.filter((e) => e.event === 'city_search');
  return {
    range: safeRange,
    searches: searchScoped.length,
    unique_cities: new Set(searchScoped.map((e) => e.city).filter(Boolean)).size,
    submissions_pending: submissions.filter((s) => s.status === 'pending').length,
    reviews_pending: reviews.filter((r) => r.status === 'pending').length
  };
}

async function executeTool(name, input = {}) {
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
      const task = await createTask({
        ownerIdentity: input.owner_identity || 'harold',
        requestedByAgentKey: input.requested_by_agent_key || 'president_agent',
        assignedAgentKey: input.assigned_agent_key,
        title: input.title,
        summary: input.summary || '',
        details: input.details || {},
        priority: input.priority || 'normal'
      });
      return { success: true, task };
    }
    case 'query_agent_tasks': {
      const tasks = await getOpenTasks({ ownerIdentity: input.owner_identity || 'harold', limit: input.limit || 30 });
      return { count: tasks.length, tasks };
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
      return queryDashboardStats(input.range || '24h');
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
    { name: 'create_agent_task', description: 'Create a task for a specialist agent when the owner request should be delegated or tracked.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, requested_by_agent_key: { type: 'string' }, assigned_agent_key: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, priority: { type: 'string' }, details: { type: 'object' }
    }, required: ['assigned_agent_key', 'title'] } },
    { name: 'query_agent_tasks', description: 'List open and in-progress agent tasks for continuity and delegation tracking.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'store_agent_memory', description: 'Persist a durable memory, preference, decision, or standing directive for an agent.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, agent_key: { type: 'string' }, memory_kind: { type: 'string' }, key: { type: 'string' }, value: { type: 'object' }, pinned: { type: 'boolean' }
    }, required: ['key', 'value'] } },
    { name: 'query_agent_memory', description: 'Read durable memory entries for an agent, including owner preferences and prior decisions.', input_schema: { type: 'object', properties: {
      owner_identity: { type: 'string' }, agent_key: { type: 'string' }, limit: { type: 'number' }
    }, required: [] } },
    { name: 'query_dashboard_stats', description: 'Get top dashboard metrics for the requested time range.', input_schema: { type: 'object', properties: { range: { type: 'string', enum: ['24h', '7d', '30d', 'all'] } }, required: [] } },
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
    'Traffic growth is the first gate for monetization. Do not forget that low traffic weakens owner-claim and sponsorship monetization.',
    'Default to working through how your existing team can fulfill the request. Use delegation/task creation before pushback.',
    'If the current team cannot do it well, recommend a new agent and explain why in one short paragraph.',
    'Only refuse or block when there is a hard legal, compliance, access, or business-rule constraint.'
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
  const input = normalizeHistory(history).concat([{ role: 'user', content: userMessage }]).map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_AGENT_MODEL,
      input: [{ role: 'system', content: systemPrompt }].concat(input),
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
  const threadSummary = summarizeThreadContext(storedMessages);
  const memorySummary = (storedMemories || []).map((m) => `- ${m.memory_kind}/${m.key}: ${JSON.stringify(m.value)}`).join('\n');
  const taskSummary = (openTasks || []).map((t) => `- ${t.assigned_agent_key}: ${t.title} [${t.status}]`).join('\n');
  const systemPrompt = buildSystemPrompt(agent, registry, channel);
  const memoryBlock = [
    'Durable memory and continuity:',
    memorySummary || '- none recorded',
    'Open delegated tasks:',
    taskSummary || '- none recorded',
    'Recent thread context:',
    threadSummary || '- no prior thread history'
  ].join('\n');
  let reply = '';
  let provider = '';
  try {
    if (!ANTHROPIC_API_KEY) throw new Error('Anthropic not configured');
    reply = await runAnthropicLoop({ systemPrompt: `${systemPrompt}\n\n${memoryBlock}`, history: storedMessages.concat(normalizeHistory(history)), userMessage: text });
    provider = 'anthropic';
  } catch (primaryErr) {
    if (!OPENAI_API_KEY) throw primaryErr;
    reply = await runOpenAiFallback({ systemPrompt: `${systemPrompt}\n\n${memoryBlock}`, history: storedMessages.concat(normalizeHistory(history)), userMessage: text });
    provider = 'openai';
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
