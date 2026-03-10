const { buildFinanceSnapshot, upsertFinanceSnapshot, sbFetch } = require('./_accounting-core');
const { sendCompliantEmail } = require('./_email-compliance');
const { logAgentActivity } = require('./_agent-activity');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONSENSUS_MODEL = process.env.REVENUE_CONSENSUS_MODEL || 'claude-sonnet-4-20250514';
const OWNER_SUMMARY_EMAIL = process.env.OWNER_SUMMARY_EMAIL || 'admin@kiddbusy.com';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function uniqCount(values) {
  const set = new Set((values || []).filter(Boolean));
  return set.size;
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function getOne(path) {
  const { response, data } = await sbFetch(path);
  if (!response.ok) return null;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getRows(path) {
  const { response, data } = await sbFetch(path);
  if (!response.ok || !Array.isArray(data)) return [];
  return data;
}

function isInternalRow(row) {
  if (!row || typeof row !== 'object') return false;
  return !!(row.is_internal || String(row.source || '').toLowerCase() === 'internal');
}

async function buildConsensusInput() {
  const now = new Date();
  const since7 = daysAgoIso(7);
  const since30 = daysAgoIso(30);

  const [
    cmoSettings,
    analyticsRows,
    ownerClaims,
    sponsorships,
    latestActivity
  ] = await Promise.all([
    getOne('cmo_agent_settings?id=eq.1&select=*'),
    getRows(`analytics?select=event,session_id,city,source,is_internal,created_at&created_at=gte.${encodeURIComponent(since30)}&limit=12000`),
    getRows(`owner_claims?select=id,status,created_at,city&created_at=gte.${encodeURIComponent(since30)}&limit=5000`),
    getRows(`sponsorships?select=id,status,created_at,city,plan,business_name,email&created_at=gte.${encodeURIComponent(since30)}&limit=5000`),
    getRows('agent_activity?select=agent_key,status,summary,created_at&order=created_at.desc&limit=80')
  ]);

  const financeSnapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());

  const analyticsPublic = analyticsRows.filter((r) => !isInternalRow(r));
  const analytics7 = analyticsPublic.filter((r) => {
    const ts = r && r.created_at ? new Date(r.created_at).getTime() : NaN;
    return Number.isFinite(ts) && ts >= new Date(since7).getTime();
  });

  const sessions7 = uniqCount(analytics7.map((r) => r.session_id));
  const sessions30 = uniqCount(analyticsPublic.map((r) => r.session_id));

  const byEvent7 = {};
  for (const row of analytics7) {
    const k = String((row && row.event) || 'unknown');
    byEvent7[k] = (byEvent7[k] || 0) + 1;
  }

  const ownerClaimsSubmitted30 = ownerClaims.length;
  const ownerClaimsApproved30 = ownerClaims.filter((r) => String(r.status || '').toLowerCase() === 'approved').length;

  const sponsorPending30 = sponsorships.filter((s) => String(s.status || '').toLowerCase() === 'pending').length;
  const sponsorActive30 = sponsorships.filter((s) => String(s.status || '').toLowerCase() === 'active').length;
  const sponsorCancelled30 = sponsorships.filter((s) => String(s.status || '').toLowerCase() === 'cancelled').length;

  const recentCmoActivity = latestActivity
    .filter((a) => String(a.agent_key || '') === 'cmo_agent')
    .slice(0, 12)
    .map((a) => ({ status: a.status, summary: a.summary, created_at: a.created_at }));
  const recentAccountantActivity = latestActivity
    .filter((a) => String(a.agent_key || '') === 'accountant_agent')
    .slice(0, 12)
    .map((a) => ({ status: a.status, summary: a.summary, created_at: a.created_at }));

  return {
    generated_at: now.toISOString(),
    cmo_settings: cmoSettings || {},
    finance_snapshot: financeSnapshot,
    metrics: {
      sessions_7d: sessions7,
      sessions_30d: sessions30,
      event_counts_7d: byEvent7,
      owner_claims_submitted_30d: ownerClaimsSubmitted30,
      owner_claims_approved_30d: ownerClaimsApproved30,
      sponsor_pending_30d: sponsorPending30,
      sponsor_active_30d: sponsorActive30,
      sponsor_cancelled_30d: sponsorCancelled30
    },
    agent_context: {
      cmo_recent: recentCmoActivity,
      accountant_recent: recentAccountantActivity
    }
  };
}

function extractTextFromAnthropic(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content
    .filter((c) => c && c.type === 'text' && c.text)
    .map((c) => String(c.text))
    .join('\n')
    .trim();
}

function safeParseJsonCandidate(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
}

async function generateConsensusReport(input) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const system = [
    'You are a strict executive facilitation agent for KiddBusy.',
    'Simulate a daily working session between two internal agents: CMO and Accountant.',
    'Goal: agree on practical, revenue-increasing actions that respect constraints.',
    'Return strict JSON only, with no markdown fences.'
  ].join(' ');

  const prompt = [
    'Using the input JSON below, produce a consensus summary for the owner.',
    'Required output JSON keys:',
    '- subject (string, <=120 chars)',
    '- summary_text (string, 6-10 sentences, plain English)',
    '- summary_html (string, concise readable HTML with <h2>, <p>, <ul>, <li>)',
    '- recommendations (array of exactly 5 items, each item has: action, owner, expected_impact, metric, target_30d)',
    '- watchouts (array of 2-5 strings)',
    '- confidence (number 0..1)',
    'Constraints:',
    '- No paid ads.',
    '- Keep legal/compliance safe.',
    '- Assume email cap and contact cap must be respected.',
    '- Favor highest ROI actions first.',
    'Input JSON:',
    JSON.stringify(input)
  ].join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CONSENSUS_MODEL,
      max_tokens: 1600,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error((body && body.error && body.error.message) || 'Consensus model request failed');
  }

  const text = extractTextFromAnthropic(body);
  const parsed = safeParseJsonCandidate(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Consensus model returned non-JSON output');
  }

  return {
    subject: String(parsed.subject || 'Daily Revenue Consensus').slice(0, 120),
    summary_text: String(parsed.summary_text || 'No summary generated.'),
    summary_html: String(parsed.summary_html || '<p>No summary generated.</p>'),
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
    watchouts: Array.isArray(parsed.watchouts) ? parsed.watchouts.slice(0, 8) : [],
    confidence: Math.max(0, Math.min(1, safeNum(parsed.confidence)))
  };
}

async function persistConsensusReport(report, input) {
  const row = {
    agentKey: 'revenue_consensus_agent',
    status: 'success',
    summary: report.summary_text.slice(0, 1100),
    details: {
      subject: report.subject,
      recommendations: report.recommendations,
      watchouts: report.watchouts,
      confidence: report.confidence,
      finance_snapshot: input.finance_snapshot,
      metrics: input.metrics,
      generated_at: input.generated_at
    }
  };

  await logAgentActivity(row);
  await logAgentActivity({
    agentKey: 'cmo_agent',
    status: 'info',
    summary: `Daily CMO+Accountant consensus prepared: ${report.subject}`,
    details: { confidence: report.confidence, recommendations: report.recommendations }
  });
  await logAgentActivity({
    agentKey: 'accountant_agent',
    status: 'info',
    summary: `Daily CMO+Accountant consensus prepared: ${report.subject}`,
    details: { confidence: report.confidence, recommendations: report.recommendations }
  });
}

async function sendConsensusEmail(report) {
  const to = OWNER_SUMMARY_EMAIL;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:8px 0">
      <p style="font-size:12px;letter-spacing:.4px;color:#6b7280;text-transform:uppercase;margin:0 0 10px">KiddBusy Daily Agent Consensus</p>
      ${report.summary_html}
      <h2 style="font-size:18px;margin:18px 0 10px">Top 5 Actions</h2>
      <ul style="padding-left:18px;margin:0 0 12px">
        ${(report.recommendations || []).map((r) => `<li style="margin:8px 0"><strong>${String(r.action || '')}</strong> - ${String(r.expected_impact || '')}<br/><span style="color:#6b7280">Owner: ${String(r.owner || '')} | Metric: ${String(r.metric || '')} | 30d target: ${String(r.target_30d || '')}</span></li>`).join('')}
      </ul>
      ${report.watchouts && report.watchouts.length ? `<p style="margin:12px 0 6px"><strong>Watchouts:</strong></p><ul style="padding-left:18px;margin:0">${report.watchouts.map((w) => `<li>${String(w)}</li>`).join('')}</ul>` : ''}
      <p style="margin-top:14px;color:#6b7280;font-size:12px">Confidence: ${(report.confidence * 100).toFixed(0)}%</p>
    </div>
  `;

  return sendCompliantEmail({
    to,
    subject: report.subject,
    body: html,
    fromName: 'KiddBusy Agent Council',
    campaignType: 'agent_daily_consensus'
  });
}

async function runRevenueConsensus() {
  const input = await buildConsensusInput();
  const report = await generateConsensusReport(input);
  await persistConsensusReport(report, input);
  const emailResult = await sendConsensusEmail(report);

  return {
    success: true,
    recipient: OWNER_SUMMARY_EMAIL,
    subject: report.subject,
    confidence: report.confidence,
    recommendations_count: Array.isArray(report.recommendations) ? report.recommendations.length : 0,
    email_suppressed: !!(emailResult && emailResult.suppressed)
  };
}

module.exports = {
  json,
  runRevenueConsensus
};
