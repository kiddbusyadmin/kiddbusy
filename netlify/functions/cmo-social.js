const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const INSTAGRAM_AUTOMATION_ENABLED = String(process.env.CMO_INSTAGRAM_AUTOMATION_ENABLED || '').toLowerCase() === 'true';
const { logAgentActivity } = require('./_agent-activity');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
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
  } catch {
    data = text;
  }
  return { response, data };
}

function startOfDayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function ymdStamp(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function fetchConfig() {
  const q = 'cmo_agent_settings?id=eq.1&select=instagram_handle,instagram_mode,instagram_profile_ready,instagram_notifications_ready,instagram_kickoff_posts_target,instagram_daily_posts_target';
  const { response, data } = await sbFetch(q);
  if (!response.ok) throw new Error('Failed to read CMO social config');
  const row = Array.isArray(data) && data.length ? data[0] : {};
  return {
    instagram_handle: String(row.instagram_handle || '').trim(),
    instagram_mode: String(row.instagram_mode || 'creator').toLowerCase() === 'business' ? 'business' : 'creator',
    instagram_profile_ready: !!row.instagram_profile_ready,
    instagram_notifications_ready: !!row.instagram_notifications_ready,
    instagram_kickoff_posts_target: Math.min(Math.max(Number(row.instagram_kickoff_posts_target) || 3, 1), 20),
    instagram_daily_posts_target: Math.min(Math.max(Number(row.instagram_daily_posts_target) || 1, 1), 10)
  };
}

async function upsertTask(task) {
  const { response, data } = await sbFetch('cmo_social_tasks?on_conflict=task_key', {
    method: 'POST',
    body: task,
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!response.ok) {
    throw new Error('Failed to upsert social task');
  }
  return Array.isArray(data) ? data[0] : data;
}

async function listTasks(limit, status) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const filters = ['select=*', 'channel=eq.instagram', 'order=created_at.desc', `limit=${capped}`];
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
  const { response, data } = await sbFetch(`cmo_social_tasks?${filters.join('&')}`);
  if (!response.ok) throw new Error('Failed to list CMO social tasks');
  return Array.isArray(data) ? data : [];
}

async function completeTask(taskId, status) {
  const sid = Number(taskId);
  if (!Number.isFinite(sid) || sid <= 0) throw new Error('task_id is required');
  const nextStatus = ['completed', 'blocked', 'skipped'].includes(String(status || '').toLowerCase())
    ? String(status || '').toLowerCase()
    : 'completed';
  const patch = {
    status: nextStatus,
    completed_at: nextStatus === 'completed' ? new Date().toISOString() : null
  };
  const { response, data } = await sbFetch(`cmo_social_tasks?task_id=eq.${encodeURIComponent(String(sid))}`, {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  if (!response.ok) throw new Error('Failed to update social task');
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function fetchContextSignals() {
  const since = encodeURIComponent(startOfDayIso());
  const [events, blog] = await Promise.all([
    sbFetch(`analytics?select=event,city,created_at&event=eq.city_search&created_at=gte.${since}&order=created_at.desc&limit=3000`),
    sbFetch('blog_posts?select=title,slug,city,published_at&status=eq.published&order=published_at.desc&limit=20')
  ]);

  var topCity = '';
  if (events.response.ok && Array.isArray(events.data)) {
    const countByCity = {};
    for (const e of events.data) {
      const c = String(e.city || '').trim();
      if (!c) continue;
      countByCity[c] = (countByCity[c] || 0) + 1;
    }
    const top = Object.entries(countByCity).sort((a, b) => b[1] - a[1])[0];
    if (top) topCity = top[0];
  }

  const latestBlog = blog.response.ok && Array.isArray(blog.data) && blog.data.length ? blog.data[0] : null;
  return { top_city: topCity, latest_blog: latestBlog };
}

function kickoffInstructions(index, cfg) {
  const handle = cfg.instagram_handle ? `@${cfg.instagram_handle.replace(/^@/, '')}` : '@kiddbusyhq';
  return [
    `Create kickoff post ${index} of ${cfg.instagram_kickoff_posts_target} for ${handle}.`,
    'Include one clear parent value proposition and one city-specific weekend action.',
    'Use link in bio CTA to https://kiddbusy.com and include local hashtags.'
  ].join(' ');
}

function dailyInstructions(cfg, signals, index) {
  const city = signals.top_city || 'your top traffic city';
  const blogTitle = signals.latest_blog && signals.latest_blog.title ? signals.latest_blog.title : 'latest weekend guide';
  const blogUrl = signals.latest_blog && signals.latest_blog.slug ? `https://kiddbusy.com/blog/${signals.latest_blog.slug}` : 'https://kiddbusy.com/blog/';
  return [
    `Create daily Instagram post ${index} of ${cfg.instagram_daily_posts_target} focused on ${city}.`,
    `Anchor post on: "${blogTitle}" and include CTA to ${blogUrl}.`,
    'Format: short hook, 3 bullets, one CTA, and 8-12 relevant hashtags.'
  ].join(' ');
}

async function runPlanner() {
  if (!INSTAGRAM_AUTOMATION_ENABLED) {
    return {
      created: [],
      open: [],
      disabled: true,
      reason: 'Instagram automation disabled until a direct publishing integration is configured'
    };
  }
  const cfg = await fetchConfig();
  const signals = await fetchContextSignals();
  const openTasks = await listTasks(1000, 'open');
  const openKeySet = new Set(openTasks.map((t) => String(t.task_key || '')));

  const created = [];
  const nowIso = new Date().toISOString();
  const today = new Date();
  const ymd = ymdStamp(today);

  if (!cfg.instagram_profile_ready && !openKeySet.has('ig_profile_setup')) {
    created.push(await upsertTask({
      task_key: 'ig_profile_setup',
      channel: 'instagram',
      task_type: 'onboarding_profile',
      status: 'open',
      title: 'Finalize Instagram profile setup',
      instructions: 'Set bio, website link to https://kiddbusy.com, and contact email admin@kiddbusy.com. Mark task complete once done.',
      due_at: nowIso,
      payload: { blocker: 'human_required', reason: 'Meta profile settings UI' }
    }));
  }

  if (!cfg.instagram_notifications_ready && !openKeySet.has('ig_notifications_enable')) {
    created.push(await upsertTask({
      task_key: 'ig_notifications_enable',
      channel: 'instagram',
      task_type: 'onboarding_notifications',
      status: 'open',
      title: 'Enable IG comment/DM notifications',
      instructions: 'Enable comment and DM notifications in Instagram app so leads are answered quickly.',
      due_at: nowIso,
      payload: { blocker: 'human_required', reason: 'Device-level notification controls' }
    }));
  }

  const kickoffCompleted = (await listTasks(1000, 'completed')).filter((t) => String(t.task_type || '') === 'kickoff_post').length;
  const remainingKickoff = Math.max(0, cfg.instagram_kickoff_posts_target - kickoffCompleted);
  for (let i = 1; i <= remainingKickoff; i++) {
    const key = `ig_kickoff_post_${i}`;
    if (openKeySet.has(key)) continue;
    created.push(await upsertTask({
      task_key: key,
      channel: 'instagram',
      task_type: 'kickoff_post',
      status: 'open',
      title: `Publish kickoff Instagram post ${i}/${cfg.instagram_kickoff_posts_target}`,
      instructions: kickoffInstructions(i, cfg),
      due_at: nowIso,
      payload: { post_number: i, total: cfg.instagram_kickoff_posts_target }
    }));
  }

  for (let i = 1; i <= cfg.instagram_daily_posts_target; i++) {
    const key = `ig_daily_post_${ymd}_${i}`;
    if (openKeySet.has(key)) continue;
    created.push(await upsertTask({
      task_key: key,
      channel: 'instagram',
      task_type: 'daily_post',
      status: 'open',
      title: `Create/publish daily Instagram post ${i}/${cfg.instagram_daily_posts_target}`,
      instructions: dailyInstructions(cfg, signals, i),
      due_at: nowIso,
      payload: {
        day: ymd,
        slot: i,
        top_city: signals.top_city || null,
        latest_blog_slug: signals.latest_blog && signals.latest_blog.slug ? signals.latest_blog.slug : null
      }
    }));
  }

  const openAfter = await listTasks(1000, 'open');
  await logAgentActivity({
    agentKey: 'cmo_agent',
    status: 'success',
    summary: `CMO Instagram planner run: created ${created.length} tasks, open queue ${openAfter.length}.`,
    details: {
      workflow: 'instagram_ops_planner',
      instagram_handle: cfg.instagram_handle || null,
      instagram_mode: cfg.instagram_mode,
      created_count: created.length,
      open_count: openAfter.length,
      top_city_signal: signals.top_city || null,
      latest_blog_slug: signals.latest_blog && signals.latest_blog.slug ? signals.latest_blog.slug : null
    }
  });

  return { created, open: openAfter, config: cfg, signals };
}

async function handler(event) {
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!['kiddbusy-hq', 'kiddbusy-agent'].includes(source)) {
    return json(403, { error: 'Forbidden' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body = {};
  if (event.httpMethod === 'POST') {
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
  } else {
    body = event.queryStringParameters || {};
  }

  const action = String(body.action || 'list').trim();
  try {
    if (!INSTAGRAM_AUTOMATION_ENABLED) {
      if (action === 'list') {
        return json(200, {
          success: true,
          disabled: true,
          reason: 'Instagram automation disabled until a direct publishing integration is configured',
          count: 0,
          tasks: []
        });
      }
      return json(409, {
        error: 'Instagram automation is disabled until a direct publishing integration is configured',
        disabled: true
      });
    }
    if (action === 'list') {
      const tasks = await listTasks(body.limit || 300, body.status || '');
      return json(200, { success: true, count: tasks.length, tasks });
    }
    if (action === 'complete_task') {
      const task = await completeTask(body.task_id, body.status);
      return json(200, { success: true, task });
    }
    if (action === 'run') {
      const result = await runPlanner();
      return json(200, {
        success: true,
        created_count: result.created.length,
        open_count: result.open.length,
        created: result.created,
        config: result.config,
        signals: result.signals
      });
    }

    return json(400, { error: 'Unsupported action', supported_actions: ['list', 'complete_task', 'run'] });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
}

module.exports = {
  handler,
  runPlanner
};
