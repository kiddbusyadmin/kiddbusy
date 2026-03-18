const { runCmoBlog } = require('./_cmo-blog-core');
const { runAgentConversation } = require('./_agent-router-core');
const accountantAgent = require('./accountant-agent');
const { logAgentActivity } = require('./_agent-activity');
const { upsertResearchArtifact, inferQuestion, inferCity } = require('./_research-memory');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const STALE_OPEN_MINUTES = Math.max(Number(process.env.AGENT_TASK_STALE_OPEN_MINUTES) || 20, 5);
const STALE_IN_PROGRESS_MINUTES = Math.max(Number(process.env.AGENT_TASK_STALE_IN_PROGRESS_MINUTES) || 45, 10);
const STALE_ESCALATE_MINUTES = Math.max(Number(process.env.AGENT_TASK_STALE_ESCALATE_MINUTES) || 90, 15);
const WATCHDOG_ESCALATION_COOLDOWN_MINUTES = Math.max(Number(process.env.AGENT_TASK_ESCALATION_COOLDOWN_MINUTES) || 180, 30);

function nowIso() {
  return new Date().toISOString();
}

function minutesSince(value) {
  const ms = new Date(String(value || '')).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60000));
}

function cleanCityName(value) {
  return String(value || '').split(',')[0].trim();
}

function extractCityFromText(value) {
  const text = String(value || '');
  const direct = text.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:,\s*[A-Z]{2})?\b/);
  if (direct && direct[1]) return cleanCityName(direct[1]);
  const atl = text.match(/\bAtlanta\b/i);
  if (atl) return 'Atlanta';
  return '';
}

function inferTaskTargetCount(task, details) {
  const explicit = Number(details.article_count) || Number(details.target_count);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.max(Math.round(explicit), 1), 25);
  const hay = [String((task && task.title) || ''), String((task && task.summary) || '')].join(' ').toLowerCase();
  const qty = hay.match(/\b(\d{1,2})\b/);
  if (qty && qty[1]) {
    const parsed = Number(qty[1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(Math.max(Math.round(parsed), 1), 25);
  }
  if (/\bbatch\b|\barticles\b|\bposts\b/.test(hay)) return 5;
  return 1;
}

function normalizeBlogTitleValue(value) {
  const minor = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'up', 'via']);
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  const words = raw.toLowerCase().split(' ');
  return words.map((word, idx) => {
    if (!word) return word;
    if (idx > 0 && idx < words.length - 1 && minor.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

async function sbRequest(path, { method = 'GET', body = null, prefer = null } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { response, data };
}

async function patchTask(taskId, patch) {
  const out = await sbRequest(`agent_tasks?task_id=eq.${encodeURIComponent(String(taskId))}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function patchOrder(orderId, patch) {
  const out = await sbRequest(`agent_orders?order_id=eq.${encodeURIComponent(String(orderId))}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  return Array.isArray(out.data) && out.data.length ? out.data[0] : null;
}

async function sendTelegram(text, chatId = TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_TOKEN || !chatId) return { ok: false, skipped: 'telegram_not_configured' };
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text || '').slice(0, 4000)
    })
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error('Telegram send failed (' + response.status + '): ' + bodyText);
  }
  return { ok: true };
}

async function runCmoBlogTask(body) {
  const response = await runCmoBlog({
    httpMethod: 'POST',
    headers: { 'x-requested-from': 'kiddbusy-hq' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try {
    data = JSON.parse((response && response.body) || '{}');
  } catch (_) {
    data = {};
  }
  if (!response || Number(response.statusCode || 500) >= 400) {
    throw new Error(data.error || 'CMO blog task failed');
  }
  return data;
}

async function runAccountantTask(body) {
  const response = await accountantAgent.handler({
    httpMethod: 'POST',
    headers: { 'x-requested-from': 'kiddbusy-hq' },
    body: JSON.stringify(body || { action: 'run_snapshot' })
  });
  let data = {};
  try {
    data = JSON.parse((response && response.body) || '{}');
  } catch (_) {
    data = {};
  }
  if (!response || Number(response.statusCode || 500) >= 400) {
    throw new Error(data.error || 'Accountant task failed');
  }
  return data;
}

async function runDelegatedAgentTask(task, order) {
  return runAgentConversation({
    role: task.assigned_agent_key,
    userMessage:
      'Complete this delegated task from President. Task: ' + String(task.title || '') +
      '\nSummary: ' + String(task.summary || '') +
      '\nOwner request: ' + String((order && order.request_text) || '') +
      '\nIf you cannot take external action, provide a concrete completion memo with findings and next steps.',
    history: [],
    channel: 'dashboard',
    threadKey: 'task:' + String(task.task_id),
    ownerIdentity: 'harold'
  });
}

function isContentWorkflowTask(task, order) {
  const details = Object.assign({}, (task && task.details) || {});
  const hay = [
    String((task && task.title) || ''),
    String((task && task.summary) || ''),
    String((order && order.request_text) || '')
  ].join(' ').toLowerCase();
  if (!/\b(blog|blogs|post|posts|article|articles|seo|publish|publishing|title formatting|title capitalization)\b/.test(hay)) return false;
  if (Number(details.article_count) > 0 || Number(details.target_count) > 0) return true;
  if (String(details.seo_keyword_theme || '').trim()) return true;
  if (String(details.dependent_on_agent_key || '').trim() === 'cmo_agent') return true;
  return true;
}

function isBlogTitleCleanupTask(task, order) {
  const hay = [
    String((task && task.title) || ''),
    String((task && task.summary) || ''),
    String((order && order.request_text) || '')
  ].join(' ').toLowerCase();
  return /\b(title|titles|lowercase|capitalization|live blog|style adherence|quality control|content correction|content corrections|correct on the live blog)\b/.test(hay);
}

function isTrafficCriteriaTask(task, order) {
  const hay = [
    String((task && task.title) || ''),
    String((task && task.summary) || ''),
    String((order && order.request_text) || '')
  ].join(' ').toLowerCase();
  return /\b(human versus bot|human vs bot|bot submissions|segregate this traffic|bot traffic|internal traffic|crawler|submission criteria)\b/.test(hay);
}

async function syncResearchArtifactForTask(task, order, nextStatus, resultSummary, delegatedResult) {
  if (String(task.assigned_agent_key || '') !== 'research_agent') return null;
  const details = task.details || {};
  const notes = delegatedResult && delegatedResult.reply ? String(delegatedResult.reply || '').slice(0, 20000) : '';
  const city = details.city || inferCity(task, order) || '';
  const tags = []
    .concat(Array.isArray(details.tags) ? details.tags : [])
    .concat(details.research_request ? ['research'] : [])
    .concat(city ? ['city:' + String(city).toLowerCase().replace(/\s+/g, '_')] : []);
  return upsertResearchArtifact({
    ownerIdentity: task.owner_identity || 'harold',
    taskId: task.task_id,
    orderId: details.order_id || (order && order.order_id) || null,
    agentKey: 'research_agent',
    question: inferQuestion(task, order),
    summary: String(resultSummary || '').slice(0, 2000),
    fullNotes: notes,
    status: nextStatus,
    city,
    tags,
    metadata: {
      source: 'agent_task_runner',
      provider: delegatedResult && delegatedResult.provider ? delegatedResult.provider : null,
      task_title: String(task.title || '').slice(0, 240),
      task_summary: String(task.summary || '').slice(0, 1200),
      thread_key: delegatedResult && delegatedResult.thread_key ? delegatedResult.thread_key : null
    }
  });
}

async function listCityCmoPosts(city, statuses) {
  const safeCity = encodeURIComponent(String(city || '').trim());
  if (!safeCity) return [];
  const statusList = Array.isArray(statuses) && statuses.length
    ? statuses.map((s) => String(s || '').trim()).filter(Boolean)
    : ['draft', 'published'];
  const query =
    'blog_posts?select=id,status,city,slug,title,published_at,created_at&source=eq.cmo_agent' +
    '&city=ilike.*' + safeCity + '*' +
    '&status=in.(' + statusList.map((s) => encodeURIComponent(s)).join(',') + ')' +
    '&limit=500';
  const out = await sbRequest(query, { method: 'GET' });
  return Array.isArray(out.data) ? out.data : [];
}

async function listAllBlogPostsWithTitles(limit = 5000) {
  const query = 'blog_posts?select=id,title,slug,status,source&order=created_at.desc&limit=' + String(Math.min(Math.max(Number(limit) || 5000, 1), 5000));
  const out = await sbRequest(query, { method: 'GET' });
  return Array.isArray(out.data) ? out.data : [];
}

async function normalizeAllBlogTitles() {
  const rows = await listAllBlogPostsWithTitles(5000);
  const changed = [];
  for (const row of rows) {
    const original = String((row && row.title) || '').trim();
    const next = normalizeBlogTitleValue(original);
    if (!original || original === next) continue;
    await sbRequest(`blog_posts?id=eq.${encodeURIComponent(String(row.id))}`, {
      method: 'PATCH',
      body: { title: next, updated_at: nowIso() }
    });
    changed.push({ id: row.id, slug: row.slug || '', from: original, to: next });
  }
  return changed;
}

async function listOpenTasksByAgent(agentKey) {
  const query = 'agent_tasks?select=task_id,assigned_agent_key,status,details,title&assigned_agent_key=eq.' +
    encodeURIComponent(String(agentKey || '')) +
    '&status=in.(open,in_progress)&limit=50';
  const out = await sbRequest(query, { method: 'GET' });
  return Array.isArray(out.data) ? out.data : [];
}

async function loadOpenOrdersByIdMap() {
  const out = await sbRequest('agent_orders?select=*&status=in.(pending_assignment,delegated,in_progress,blocked)&limit=200', {
    method: 'GET'
  });
  const rows = Array.isArray(out.data) ? out.data : [];
  const byId = new Map();
  for (const row of rows) byId.set(String(row.order_id), row);
  return byId;
}

function buildStallMessage(task, order, ageMinutes, attemptCount, level) {
  const orderLabel = order ? ('Order #' + String(order.order_id)) : ('Task #' + String(task.task_id));
  const agentLabel = String(task.assigned_agent_key || 'subagent').replace(/_agent$/, '');
  const title = String(task.title || order?.title || 'Untitled task').trim();
  const base = `President: ${orderLabel} delegated to ${agentLabel} has been stalled for about ${ageMinutes} minutes.`;
  const detail = title ? ` Task: ${title}.` : '';
  const attempt = attemptCount > 0 ? ` Watchdog attempts so far: ${attemptCount}.` : '';
  if (level === 'escalate') {
    return `${base}${detail}${attempt} I have already tried to keep it moving and I need your attention if this remains blocked.`;
  }
  return `${base}${detail}${attempt} I am re-checking this delegation and pushing it forward.`;
}

async function runDelegationWatchdog() {
  const tasksOut = await sbRequest('agent_tasks?select=*&status=in.(open,in_progress)&order=updated_at.asc&limit=100', {
    method: 'GET'
  });
  const tasks = Array.isArray(tasksOut.data) ? tasksOut.data : [];
  const ordersById = await loadOpenOrdersByIdMap();
  const inspected = [];
  let stalledCount = 0;
  let escalatedCount = 0;

  for (const task of tasks) {
    const status = String(task.status || '').toLowerCase();
    const updatedMinutes = minutesSince(task.updated_at || task.created_at);
    if (updatedMinutes == null) continue;

    const staleThreshold = status === 'open' ? STALE_OPEN_MINUTES : STALE_IN_PROGRESS_MINUTES;
    if (updatedMinutes < staleThreshold) continue;

    const taskDetails = Object.assign({}, task.details || {});
    const watchdogAttempts = Number(taskDetails.watchdog_attempts || 0);
    const lastWatchdogMinutes = minutesSince(taskDetails.last_watchdog_at);
    if (lastWatchdogMinutes != null && lastWatchdogMinutes < 10) continue;

    const orderId = taskDetails.order_id || null;
    const order = orderId ? (ordersById.get(String(orderId)) || null) : null;
    const stalledSince = taskDetails.stalled_since || (task.updated_at || task.created_at || nowIso());
    const stalledMinutes = minutesSince(stalledSince) || updatedMinutes;
    const nextAttempts = watchdogAttempts + 1;
    const shouldEscalate =
      stalledMinutes >= STALE_ESCALATE_MINUTES ||
      watchdogAttempts >= 2 ||
      String(taskDetails.watchdog_status || '') === 'blocked';
    const lastEscalatedMinutes = minutesSince(taskDetails.last_escalated_at);
    const escalationAllowed = shouldEscalate && (lastEscalatedMinutes == null || lastEscalatedMinutes >= WATCHDOG_ESCALATION_COOLDOWN_MINUTES);

    const patchedDetails = Object.assign({}, taskDetails, {
      stalled_since: stalledSince,
      stalled_minutes: stalledMinutes,
      watchdog_attempts: nextAttempts,
      last_watchdog_at: nowIso(),
      watchdog_status: escalationAllowed ? 'escalated' : 'investigating',
      president_attention_required: !!escalationAllowed,
      watchdog_note: escalationAllowed
        ? 'President escalated this stalled delegation to the owner.'
        : 'President detected a stalled delegation and is attempting to recover it.'
    });

    const nextTaskStatus = escalationAllowed ? 'in_progress' : 'open';
    await patchTask(task.task_id, {
      status: nextTaskStatus,
      updated_at: nowIso(),
      details: Object.assign({}, patchedDetails, escalationAllowed ? { last_escalated_at: nowIso() } : {})
    });

    if (orderId) {
      const orderDetails = Object.assign({}, (order && order.details) || {}, {
        task_id: task.task_id,
        delegated_agent_key: task.assigned_agent_key || null,
        president_watchdog_status: escalationAllowed ? 'escalated' : 'investigating',
        president_watchdog_attempts: nextAttempts,
        stalled_minutes: stalledMinutes,
        last_watchdog_at: nowIso(),
        president_attention_required: !!escalationAllowed
      });
      await patchOrder(orderId, {
        status: escalationAllowed ? 'blocked' : 'in_progress',
        summary: escalationAllowed
          ? ('President escalated a stalled delegation after ' + String(stalledMinutes) + ' minutes.')
          : ('President is re-driving a stalled delegation after ' + String(stalledMinutes) + ' minutes.'),
        details: orderDetails,
        updated_at: nowIso()
      });
    }

    const activitySummary = escalationAllowed
      ? ('President escalated stalled delegation for ' + (orderId ? ('order #' + String(orderId)) : ('task #' + String(task.task_id))) + '.')
      : ('President detected and retried stalled delegation for ' + (orderId ? ('order #' + String(orderId)) : ('task #' + String(task.task_id))) + '.');
    await logAgentActivity({
      agentKey: 'president_agent',
      status: escalationAllowed ? 'warning' : 'info',
      summary: activitySummary,
      details: {
        task_id: task.task_id,
        order_id: orderId,
        assigned_agent_key: task.assigned_agent_key || null,
        task_title: task.title || '',
        stalled_minutes: stalledMinutes,
        watchdog_attempts: nextAttempts,
        escalated: !!escalationAllowed
      }
    });

    if (escalationAllowed) {
      escalatedCount += 1;
      try {
        await sendTelegram(buildStallMessage(task, order, stalledMinutes, nextAttempts, 'escalate'));
      } catch (err) {
        await logAgentActivity({
          agentKey: 'president_agent',
          status: 'error',
          summary: 'President failed to send stalled-delegation escalation on Telegram.',
          details: {
            task_id: task.task_id,
            order_id: orderId,
            error: String((err && err.message) || err || 'unknown error').slice(0, 500)
          }
        });
      }
    }

    stalledCount += 1;
    inspected.push({
      task_id: task.task_id,
      order_id: orderId,
      assigned_agent_key: task.assigned_agent_key || null,
      stalled_minutes: stalledMinutes,
      attempts: nextAttempts,
      escalated: !!escalationAllowed
    });
  }

  return {
    success: true,
    stalled_count: stalledCount,
    escalated_count: escalatedCount,
    inspected
  };
}

async function runAgentTasks() {
  const tasksOut = await sbRequest('agent_tasks?select=*&status=in.(open,in_progress)&order=created_at.asc&limit=12', {
    method: 'GET'
  });
  const tasks = Array.isArray(tasksOut.data) ? tasksOut.data.slice() : [];
  const priorityRank = { critical: 4, high: 3, normal: 2, low: 1 };
  tasks.sort((a, b) => {
    const aStatus = String(a.status || '').toLowerCase();
    const bStatus = String(b.status || '').toLowerCase();
    if (aStatus !== bStatus) {
      if (aStatus === 'open') return -1;
      if (bStatus === 'open') return 1;
    }
    const aPriority = priorityRank[String(a.priority || 'normal').toLowerCase()] || 0;
    const bPriority = priorityRank[String(b.priority || 'normal').toLowerCase()] || 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
    const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
    return aTime - bTime;
  });
  const processed = [];

  for (const task of tasks) {
    const startedAt = nowIso();
    const taskId = task.task_id;
    const taskDetails = task.details || {};
    const orderId = taskDetails.order_id || null;
    const currentStatus = String(task.status || '').toLowerCase();
    if (currentStatus === 'open') {
      await patchTask(taskId, { status: 'in_progress', updated_at: startedAt });
    }

    let order = null;
    if (orderId) {
      const orderOut = await sbRequest(`agent_orders?order_id=eq.${encodeURIComponent(String(orderId))}&select=*&limit=1`, { method: 'GET' });
      order = Array.isArray(orderOut.data) && orderOut.data.length ? orderOut.data[0] : null;
    }

    const taskContext = [
      String(task.title || ''),
      String(task.summary || ''),
      String((order && order.request_text) || ''),
      JSON.stringify(taskDetails || {})
    ].join('\n').trim();

    const finalizedAt = nowIso();
    let resultSummary = '';
    let nextStatus = 'completed';
    let activityStatus = 'success';
    let nextTaskDetails = Object.assign({}, taskDetails, {
      auto_executor: 'db_proxy_task_runner',
      last_run_at: finalizedAt
    });

    if ((String(task.assigned_agent_key || '') === 'cmo_agent' || String(task.assigned_agent_key || '') === 'operations_agent') && isBlogTitleCleanupTask(task, order)) {
      const changed = await normalizeAllBlogTitles();
      resultSummary = changed.length
        ? ('Blog title normalization complete. Restyled ' + String(changed.length) + ' titles into title case across published and queued posts.')
        : 'Blog title normalization complete. No remaining title formatting changes were needed.';
      nextTaskDetails = Object.assign({}, nextTaskDetails, {
        normalized_title_count: changed.length,
        normalized_title_ids: changed.slice(0, 50).map((row) => row.id)
      });
    } else if (String(task.assigned_agent_key || '') === 'operations_agent' && isTrafficCriteriaTask(task, order)) {
      resultSummary = 'Human-vs-bot traffic criteria implemented. Internal traffic is flagged with the explicit internal marker, bots are filtered by crawler user-agent detection, and remaining recognized interaction events with valid session ids are treated as likely human traffic.';
      nextTaskDetails = Object.assign({}, nextTaskDetails, {
        criteria_version: '2026-03-18',
        criteria_rules: [
          'internal => is_internal=true',
          'bot => crawler or preview user-agent match',
          'likely_human => known interaction event with session id, excluding internal and bot'
        ]
      });
    } else if (String(task.assigned_agent_key || '') === 'cmo_agent' && isContentWorkflowTask(task, order)) {
      const city = cleanCityName(taskDetails.city || extractCityFromText(taskContext) || '');
      const articleCount = inferTaskTargetCount(task, taskDetails);
      const seoKeywordTheme = String(taskDetails.seo_keyword_theme || '').trim().toLowerCase();
      const beforePosts = await listCityCmoPosts(city, ['draft', 'published']);
      const beforePublished = beforePosts.filter((row) => String(row.status || '') === 'published').length;
      const remainingBefore = Math.max(articleCount - beforePublished, 0);
      if (remainingBefore <= 0) {
        resultSummary = 'CMO target already satisfied' + (city ? (' for ' + city) : '') + ': ' + String(beforePublished) + '/' + String(articleCount) + ' published.';
        nextTaskDetails = Object.assign({}, nextTaskDetails, {
          city: city || taskDetails.city || '',
          target_count: articleCount,
          published_count: beforePublished,
          remaining_count: 0
        });
      } else {
        const batchSize = Math.min(1, remainingBefore);
        const result = await runCmoBlogTask({
          target_city: city || '',
          seo_keyword_theme: seoKeywordTheme || undefined,
          queue_target: batchSize,
          max_generate_per_run: batchSize,
          force_publish_generated: true,
          publish_rate: batchSize,
          distribution_enabled: true
        });
        const afterPosts = await listCityCmoPosts(city, ['draft', 'published']);
        const afterPublished = afterPosts.filter((row) => String(row.status || '') === 'published').length;
        const remainingAfter = Math.max(articleCount - afterPublished, 0);
        nextTaskDetails = Object.assign({}, nextTaskDetails, {
          city: city || taskDetails.city || '',
          seo_keyword_theme: seoKeywordTheme || '',
          target_count: articleCount,
          published_count: afterPublished,
          draft_count: afterPosts.filter((row) => String(row.status || '') === 'draft').length,
          last_batch_size: batchSize,
          last_generated_count: Number(result.generated_count || 0),
          last_published_count: Number(result.published_count || 0),
          remaining_count: remainingAfter
        });
        resultSummary = 'CMO progress' +
          (city ? (' for ' + city) : '') +
          ': published ' + String(afterPublished) + '/' + String(articleCount) +
          ', generated ' + String(result.generated_count || 0) +
          ', published this run ' + String(result.published_count || 0) + '.';
        if (remainingAfter > 0) {
          nextStatus = 'in_progress';
          activityStatus = 'info';
          resultSummary += ' Remaining: ' + String(remainingAfter) + '.';
        }
      }
    } else if (String(task.assigned_agent_key || '') === 'operations_agent' && isContentWorkflowTask(task, order)) {
      const city = cleanCityName(taskDetails.city || extractCityFromText(taskContext) || '');
      const articleCount = inferTaskTargetCount(task, taskDetails);
      const seoKeywordTheme = String(taskDetails.seo_keyword_theme || '').trim().toLowerCase();
      const cityPosts = await listCityCmoPosts(city, ['draft', 'published']);
      const publishedCount = cityPosts.filter((row) => String(row.status || '') === 'published').length;
      const draftCount = cityPosts.filter((row) => String(row.status || '') === 'draft').length;
      nextTaskDetails = Object.assign({}, nextTaskDetails, {
        city: city || taskDetails.city || '',
        target_count: articleCount,
        published_count: publishedCount,
        draft_count: draftCount,
        remaining_count: Math.max(articleCount - publishedCount, 0)
      });
      if (publishedCount >= articleCount) {
        resultSummary = 'Operations verified publication target' + (city ? (' for ' + city) : '') + ': ' + String(publishedCount) + '/' + String(articleCount) + ' published.';
      } else if (draftCount > 0) {
        const publishBatch = Math.min(1, draftCount, articleCount - publishedCount);
        const result = await runCmoBlogTask({
          target_city: city || '',
          seo_keyword_theme: seoKeywordTheme || undefined,
          queue_target: 1,
          max_generate_per_run: 0,
          force_publish_generated: false,
          publish_rate: publishBatch,
          distribution_enabled: true
        });
        const afterPosts = await listCityCmoPosts(city, ['draft', 'published']);
        const afterPublished = afterPosts.filter((row) => String(row.status || '') === 'published').length;
        const remainingAfter = Math.max(articleCount - afterPublished, 0);
        nextTaskDetails = Object.assign({}, nextTaskDetails, {
          published_count: afterPublished,
          draft_count: afterPosts.filter((row) => String(row.status || '') === 'draft').length,
          last_published_count: Number(result.published_count || 0),
          remaining_count: remainingAfter
        });
        resultSummary = 'Operations pushed publication' +
          (city ? (' for ' + city) : '') +
          ': published ' + String(afterPublished) + '/' + String(articleCount) +
          ', published this run ' + String(result.published_count || 0) + '.';
        if (remainingAfter > 0) {
          nextStatus = 'in_progress';
          activityStatus = 'info';
          resultSummary += ' Waiting for more CMO inventory.';
        }
      } else {
        const cmoOpenTasks = await listOpenTasksByAgent('cmo_agent');
        nextStatus = 'in_progress';
        activityStatus = 'info';
        resultSummary = 'Operations waiting on CMO content' +
          (city ? (' for ' + city) : '') +
          ': published ' + String(publishedCount) + '/' + String(articleCount) +
          ', drafts ' + String(draftCount) +
          ', open CMO tasks ' + String(cmoOpenTasks.length) + '.';
      }
    } else if (String(task.assigned_agent_key || '') === 'accountant_agent') {
      const result = await runAccountantTask({ action: 'run_snapshot' });
      const snap = result.snapshot || {};
      resultSummary = 'Accountant refreshed finance snapshot. MRR $' + String(snap.mrr_active || 0) +
        ', 30d net $' + String(snap.net_projection_30d || 0) + '.';
    } else {
      const result = await runDelegatedAgentTask(task, order);
      resultSummary = String(result.reply || '').slice(0, 1000) || ('Task ' + String(taskId) + ' completed.');
      if (String(task.assigned_agent_key || '') === 'research_agent') {
        const artifact = await syncResearchArtifactForTask(task, order, nextStatus, resultSummary, result);
        if (artifact && artifact.artifact_id) {
          nextTaskDetails.research_artifact_id = artifact.artifact_id;
          nextTaskDetails.research_question = artifact.question || nextTaskDetails.research_question || null;
        }
      }
    }

    const taskPatch = {
      status: nextStatus,
      summary: resultSummary.slice(0, 1200),
      details: Object.assign({}, nextTaskDetails, {
        result_summary: resultSummary.slice(0, 600)
      }),
      updated_at: finalizedAt
    };
    if (nextStatus === 'completed') taskPatch.completed_at = finalizedAt;
    await patchTask(taskId, taskPatch);

    if (orderId) {
      const orderDetails = Object.assign({}, (order && order.details) || {}, {
        last_progress_agent_key: task.assigned_agent_key || null,
        task_id: taskId,
        task_status: nextStatus
      });
      if (nextStatus === 'completed') orderDetails.completed_by_agent_key = task.assigned_agent_key || null;
      const orderPatch = {
        status: nextStatus === 'completed' ? 'completed' : 'in_progress',
        summary: resultSummary.slice(0, 1200),
        updated_at: finalizedAt,
        details: orderDetails
      };
      if (nextStatus === 'completed') orderPatch.completed_at = finalizedAt;
      await sbRequest(`agent_orders?order_id=eq.${encodeURIComponent(String(orderId))}`, {
        method: 'PATCH',
        body: orderPatch
      });
    }

    await sbRequest('agent_activity', {
      method: 'POST',
      body: {
        agent_key: task.assigned_agent_key || 'unknown',
        summary: resultSummary.slice(0, 1200),
        status: activityStatus,
        details: {
          task_id: taskId,
          order_id: orderId,
          run_type: 'agent_task_runner',
          task_title: task.title || '',
          task_status: nextStatus
        }
      }
    });

    processed.push({
      task_id: taskId,
      assigned_agent_key: task.assigned_agent_key,
      status: nextStatus,
      summary: resultSummary.slice(0, 240)
    });
  }

  return { success: true, processed_count: processed.length, processed };
}

module.exports = {
  runAgentTasks,
  runDelegationWatchdog
};
