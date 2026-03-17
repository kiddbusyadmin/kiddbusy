const { runCmoBlog } = require('./_cmo-blog-core');
const { runAgentConversation } = require('./_agent-router-core');
const accountantAgent = require('./accountant-agent');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function nowIso() {
  return new Date().toISOString();
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

async function listOpenTasksByAgent(agentKey) {
  const query = 'agent_tasks?select=task_id,assigned_agent_key,status,details,title&assigned_agent_key=eq.' +
    encodeURIComponent(String(agentKey || '')) +
    '&status=in.(open,in_progress)&limit=50';
  const out = await sbRequest(query, { method: 'GET' });
  return Array.isArray(out.data) ? out.data : [];
}

async function runAgentTasks() {
  const tasksOut = await sbRequest('agent_tasks?select=*&status=in.(open,in_progress)&order=created_at.asc&limit=12', {
    method: 'GET'
  });
  const tasks = Array.isArray(tasksOut.data) ? tasksOut.data : [];
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

    if (String(task.assigned_agent_key || '') === 'cmo_agent') {
      const city = cleanCityName(taskDetails.city || extractCityFromText(taskContext) || '');
      const articleCount = Math.min(Math.max(Number(taskDetails.article_count) || Number(taskDetails.target_count) || 5, 1), 25);
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
    } else if (String(task.assigned_agent_key || '') === 'operations_agent') {
      const city = cleanCityName(taskDetails.city || extractCityFromText(taskContext) || '');
      const articleCount = Math.min(Math.max(Number(taskDetails.article_count) || Number(taskDetails.target_count) || 5, 1), 25);
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
  runAgentTasks
};
