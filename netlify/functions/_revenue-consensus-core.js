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

function startOfUtcDayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
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
    '- Paid ads are allowed only if there is a quantified business case and execution plan.',
    '- Any paid ads recommendation must include: channel, budget cap, CAC assumption, conversion assumption, expected payback period, and stop-loss threshold.',
    '- Keep legal/compliance safe.',
    '- Assume email cap and contact cap must be respected.',
    '- Favor highest ROI actions first.',
    '- Critical traffic gate: if sessions_30d is below monthly_unique_visit_target, recommendations must be traffic-first.',
    '- When below traffic target, do not prioritize monetization asks (owner-claim outreach or sponsorship sales) as primary actions.',
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

function isMonetizationAction(rec) {
  const text = String((rec && rec.action) || '').toLowerCase();
  const metric = String((rec && rec.metric) || '').toLowerCase();
  return (
    text.indexOf('sponsor') >= 0 ||
    text.indexOf('sponsorship') >= 0 ||
    text.indexOf('owner claim') >= 0 ||
    text.indexOf('claim outreach') >= 0 ||
    metric.indexOf('sponsor') >= 0 ||
    metric.indexOf('owner_claim') >= 0
  );
}

function isPaidAdsAction(rec) {
  const text = String((rec && rec.action) || '').toLowerCase();
  const metric = String((rec && rec.metric) || '').toLowerCase();
  return (
    text.indexOf('paid ad') >= 0 ||
    text.indexOf('paid social') >= 0 ||
    text.indexOf('google ads') >= 0 ||
    text.indexOf('meta ads') >= 0 ||
    text.indexOf('ad spend') >= 0 ||
    metric.indexOf('paid') >= 0
  );
}

function hasRockSolidAdsCase(rec) {
  const impact = String((rec && rec.expected_impact) || '').toLowerCase();
  const target = String((rec && rec.target_30d) || '').toLowerCase();
  const text = String((rec && rec.action) || '').toLowerCase() + ' ' + impact + ' ' + target;
  const requiredSignals = [
    'budget',
    'cac',
    'conversion',
    'payback',
    'stop-loss'
  ];
  return requiredSignals.every((k) => text.indexOf(k) >= 0);
}

function trafficFirstTemplates(targetSessions) {
  const target = Number(targetSessions) > 0 ? Number(targetSessions) : 1000;
  return [
    {
      action: 'Improve city search entry-point visibility and reduce first-click friction on homepage',
      owner: 'CMO',
      expected_impact: 'Increase top-of-funnel sessions from organic and direct visitors',
      metric: 'sessions_30d',
      target_30d: target
    },
    {
      action: 'Publish high-intent local weekend/event content with strong internal links from blog to city pages',
      owner: 'CMO',
      expected_impact: 'Lift search-driven traffic and return visits',
      metric: 'sessions_30d',
      target_30d: target
    },
    {
      action: 'Expand event source coverage and freshness in top cities to improve repeat usage',
      owner: 'CMO',
      expected_impact: 'Higher weekly active sessions and lower bounce',
      metric: 'sessions_7d',
      target_30d: Math.round(target / 4)
    },
    {
      action: 'Optimize newsletter capture CTA placement and messaging on high-traffic surfaces',
      owner: 'CMO',
      expected_impact: 'Build retained audience for recurring traffic',
      metric: 'signup_conversion',
      target_30d: '>=10%'
    },
    {
      action: 'Delay aggressive monetization asks until traffic baseline is met; monitor runway weekly',
      owner: 'Accountant',
      expected_impact: 'Preserve credibility while traffic compounds',
      metric: 'sessions_30d',
      target_30d: target
    }
  ];
}

function enforceTrafficGate(report, input) {
  const metrics = (input && input.metrics) || {};
  const settings = (input && input.cmo_settings) || {};
  const sessions30d = Number(metrics.sessions_30d || 0);
  const trafficTarget = Number(settings.monthly_unique_visit_target || 1000);
  const belowTarget = Number.isFinite(trafficTarget) ? sessions30d < trafficTarget : sessions30d < 1000;
  if (!belowTarget) return report;

  const kept = (report.recommendations || []).filter((r) => !isMonetizationAction(r));
  const templates = trafficFirstTemplates(trafficTarget);
  const merged = kept.slice(0, 5);
  for (let i = 0; i < templates.length && merged.length < 5; i += 1) {
    merged.push(templates[i]);
  }

  const watchouts = Array.isArray(report.watchouts) ? report.watchouts.slice(0, 8) : [];
  const gateNote = `Traffic gate active: sessions_30d (${sessions30d}) is below target (${trafficTarget}); prioritize traffic before monetization asks.`;
  if (watchouts.indexOf(gateNote) < 0) watchouts.unshift(gateNote);

  const summaryPrefix = `Traffic gate active: current sessions (${sessions30d}) are below target (${trafficTarget}), so monetization asks are deprioritized.`;
  const summaryText = String(report.summary_text || '');
  const patchedSummary = summaryText.indexOf('Traffic gate active:') === 0
    ? summaryText
    : `${summaryPrefix} ${summaryText}`;

  const summaryHtml = String(report.summary_html || '<p>No summary generated.</p>');
  const gateHtml = `<p><strong>Traffic gate active:</strong> sessions_30d (${sessions30d}) is below target (${trafficTarget}), so traffic growth actions are prioritized before monetization asks.</p>`;
  const patchedHtml = summaryHtml.indexOf('Traffic gate active') >= 0 ? summaryHtml : gateHtml + summaryHtml;

  return {
    subject: report.subject,
    summary_text: patchedSummary,
    summary_html: patchedHtml,
    recommendations: merged,
    watchouts,
    confidence: report.confidence
  };
}

function enforcePaidAdsBusinessCase(report) {
  const recs = Array.isArray(report.recommendations) ? report.recommendations : [];
  if (!recs.length) return report;

  const filtered = recs.filter((r) => {
    if (!isPaidAdsAction(r)) return true;
    return hasRockSolidAdsCase(r);
  });

  if (filtered.length === recs.length) return report;

  const watchouts = Array.isArray(report.watchouts) ? report.watchouts.slice(0, 8) : [];
  const note = 'Paid ads recommendations are allowed only with quantified business case details (budget, CAC, conversion, payback, stop-loss).';
  if (watchouts.indexOf(note) < 0) watchouts.unshift(note);

  return {
    subject: report.subject,
    summary_text: report.summary_text,
    summary_html: report.summary_html,
    recommendations: filtered.slice(0, 5),
    watchouts,
    confidence: report.confidence
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

async function consensusAlreadySentToday() {
  try {
    const since = startOfUtcDayIso();
    const to = encodeURIComponent(String(OWNER_SUMMARY_EMAIL || '').toLowerCase());
    const path = [
      'email_send_log?select=id,created_at',
      `to_email=eq.${to}`,
      'campaign_type=eq.agent_daily_consensus',
      'status=eq.sent',
      `created_at=gte.${encodeURIComponent(since)}`,
      'limit=1',
      'order=created_at.desc'
    ].join('&');
    const { response, data } = await sbFetch(path);
    if (!response.ok || !Array.isArray(data)) return false;
    return data.length > 0;
  } catch (_) {
    return false;
  }
}

async function runRevenueConsensus() {
  const alreadySent = await consensusAlreadySentToday();
  if (alreadySent) {
    await logAgentActivity({
      agentKey: 'revenue_consensus_agent',
      status: 'info',
      summary: 'Skipped consensus email: already sent today.'
    });
    return {
      success: true,
      recipient: OWNER_SUMMARY_EMAIL,
      skipped_duplicate_daily_send: true
    };
  }

  const input = await buildConsensusInput();
  const baseReport = await generateConsensusReport(input);
  const gatedReport = enforceTrafficGate(baseReport, input);
  const report = enforcePaidAdsBusinessCase(gatedReport);
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
