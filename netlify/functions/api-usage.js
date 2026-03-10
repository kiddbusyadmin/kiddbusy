const { sbFetch } = require('./_accounting-core');

const ANTHROPIC_ADMIN_KEY = process.env.ANTHROPIC_ADMIN_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_API_KEY || process.env.OPENAI_API_KEY || '';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgoUnix(days) {
  return Math.floor(new Date(daysAgoIso(days)).getTime() / 1000);
}

function sumNums(arr) {
  return (arr || []).reduce((acc, n) => acc + (Number(n) || 0), 0);
}

function parseMoney(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'object' && v.value != null) {
    const n = Number(v.value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { method: 'GET', headers: headers || {} });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

function summarizeAuthError(resp) {
  const status = resp && resp.status;
  if (status === 401 || status === 403) return 'auth_or_scope_error';
  if (status === 404) return 'endpoint_unavailable';
  return 'request_failed';
}

function anthropicTokenTotal(results) {
  return sumNums((results || []).map((r) => {
    const cacheCreation = r && r.cache_creation ? r.cache_creation : {};
    const cacheCreationTotal = sumNums(Object.keys(cacheCreation).map((k) => cacheCreation[k]));
    return sumNums([
      r && r.uncached_input_tokens,
      r && r.cache_read_input_tokens,
      r && r.output_tokens,
      cacheCreationTotal
    ]);
  }));
}

async function getAnthropicUsage() {
  if (!ANTHROPIC_ADMIN_KEY) {
    return {
      provider: 'anthropic',
      available: false,
      reason: 'missing_key'
    };
  }

  const start = encodeURIComponent(daysAgoIso(30));
  const end = encodeURIComponent(new Date().toISOString());
  const headers = {
    'x-api-key': ANTHROPIC_ADMIN_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  };

  const usageResp = await fetchJson(
    `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${start}&ending_at=${end}&bucket_width=1d&limit=31`,
    headers
  );

  if (!usageResp.ok) {
    return {
      provider: 'anthropic',
      available: false,
      reason: summarizeAuthError(usageResp),
      status: usageResp.status
    };
  }

  const usageBuckets = Array.isArray(usageResp.data && usageResp.data.data) ? usageResp.data.data : [];
  const tokens30d = sumNums(usageBuckets.map((b) => anthropicTokenTotal(Array.isArray(b.results) ? b.results : [])));

  const costResp = await fetchJson(
    `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}&ending_at=${end}&bucket_width=1d&limit=31`,
    headers
  );

  const costsAvailable = costResp.ok;
  const costBuckets = costsAvailable && Array.isArray(costResp.data && costResp.data.data) ? costResp.data.data : [];
  const usd30d = costsAvailable ? sumNums(costBuckets.map((b) => sumNums((b.results || []).map((r) => parseMoney(r.amount))))) : null;

  return {
    provider: 'anthropic',
    available: true,
    admin_key: String(ANTHROPIC_ADMIN_KEY).startsWith('sk-ant-admin'),
    tokens_30d: Math.round(tokens30d),
    usd_30d: usd30d == null ? null : Math.round(usd30d * 100) / 100,
    costs_available: costsAvailable,
    costs_status: costResp.status
  };
}

function openAiUsageTotal(results) {
  return sumNums((results || []).map((r) => {
    return sumNums([
      r && r.input_tokens,
      r && r.output_tokens,
      r && r.input_cached_tokens,
      r && r.input_audio_tokens,
      r && r.output_audio_tokens
    ]);
  }));
}

async function getOpenAiUsage() {
  if (!OPENAI_ADMIN_KEY) {
    return { provider: 'openai', available: false, reason: 'missing_key' };
  }

  const start = daysAgoUnix(30);
  const headers = {
    Authorization: `Bearer ${OPENAI_ADMIN_KEY}`,
    'Content-Type': 'application/json'
  };

  const usageResp = await fetchJson(
    `https://api.openai.com/v1/organization/usage/completions?start_time=${start}&limit=31`,
    headers
  );

  if (!usageResp.ok) {
    return {
      provider: 'openai',
      available: false,
      reason: summarizeAuthError(usageResp),
      status: usageResp.status
    };
  }

  const usageBuckets = Array.isArray(usageResp.data && usageResp.data.data) ? usageResp.data.data : [];
  const tokens30d = sumNums(usageBuckets.map((b) => openAiUsageTotal(Array.isArray(b.results) ? b.results : [])));

  const costResp = await fetchJson(
    `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=31`,
    headers
  );
  const costsAvailable = costResp.ok;
  const costBuckets = costsAvailable && Array.isArray(costResp.data && costResp.data.data) ? costResp.data.data : [];
  const usd30d = costsAvailable ? sumNums(costBuckets.map((b) => sumNums((b.results || []).map((r) => parseMoney(r && r.amount))))) : null;

  return {
    provider: 'openai',
    available: true,
    admin_key: String(OPENAI_ADMIN_KEY).startsWith('sk-admin-') || String(OPENAI_ADMIN_KEY).startsWith('sk-proj-'),
    tokens_30d: Math.round(tokens30d),
    usd_30d: usd30d == null ? null : Math.round(usd30d * 100) / 100,
    costs_available: costsAvailable,
    costs_status: costResp.status
  };
}

async function getLocalUsageFallback() {
  const sinceIso = daysAgoIso(30);

  const [
    emailLog,
    openAiImages,
    cmoSettings,
    photoJobs
  ] = await Promise.all([
    sbFetch(`email_send_log?select=status,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&limit=5000`),
    sbFetch(`listing_photos?select=id,provider,created_at&provider=eq.openai_image&created_at=gte.${encodeURIComponent(sinceIso)}&limit=5000`),
    sbFetch('cmo_agent_settings?id=eq.1&select=monthly_email_send_cap,max_emails_per_day'),
    sbFetch(`photo_ingestion_jobs?select=estimated_cost_usd,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&limit=5000`)
  ]);

  const emailRows = emailLog.response.ok && Array.isArray(emailLog.data) ? emailLog.data : [];
  const sent30d = emailRows.filter((r) => String(r.status || '').toLowerCase() === 'sent').length;

  const openAiRows = openAiImages.response.ok && Array.isArray(openAiImages.data) ? openAiImages.data : [];
  const openAiGenerated30d = openAiRows.length;

  const cmoRow = cmoSettings.response.ok && Array.isArray(cmoSettings.data) && cmoSettings.data[0] ? cmoSettings.data[0] : {};
  const monthlyCap = Number(cmoRow.monthly_email_send_cap || 0);
  const dailyCap = Number(cmoRow.max_emails_per_day || 0);

  const jobRows = photoJobs.response.ok && Array.isArray(photoJobs.data) ? photoJobs.data : [];
  const estimatedPhotoCost30d = Math.round(sumNums(jobRows.map((r) => parseMoney(r.estimated_cost_usd))) * 100) / 100;

  return {
    email_sent_30d: sent30d,
    email_monthly_cap: monthlyCap,
    email_daily_cap: dailyCap,
    email_cap_used_pct: monthlyCap > 0 ? Math.round((sent30d / monthlyCap) * 1000) / 10 : null,
    openai_images_generated_30d: openAiGenerated30d,
    estimated_photo_cost_usd_30d: estimatedPhotoCost30d
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const source = String(event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (source !== 'kiddbusy-hq') {
    return json(403, { error: 'Forbidden' });
  }

  try {
    const [anthropic, openai, local] = await Promise.all([
      getAnthropicUsage(),
      getOpenAiUsage(),
      getLocalUsageFallback()
    ]);

    return json(200, {
      success: true,
      as_of: new Date().toISOString(),
      window: '30d',
      providers: { anthropic, openai },
      local_fallback: local
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
