const { sbFetch } = require('./_accounting-core');

const BOT_UA_RE = /\b(bot|crawl|crawler|spider|slurp|bingpreview|headlesschrome|facebookexternalhit|whatsapp|discordbot|linkedinbot|embedly|quora link preview|googleother)\b/i;

function parseTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(.*?\.\d{1,6})(\+00:00|Z)$/);
  let normalized = raw.replace(/Z$/, '+00:00');
  if (m) {
    const left = m[1];
    const zone = m[2] === 'Z' ? '+00:00' : m[2];
    const parts = left.split('.');
    const frac = ((parts[1] || '') + '000000').slice(0, 6);
    normalized = parts[0] + '.' + frac + zone;
  }
  const dt = new Date(normalized);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function isBotEvent(row) {
  const ua = String((row && row.user_agent) || '');
  return BOT_UA_RE.test(ua);
}

function normalizeSessionId(row) {
  return String((row && row.session_id) || '').trim();
}

function rangeMs(range) {
  const key = String(range || '24h');
  if (key === '7d') return 7 * 24 * 60 * 60 * 1000;
  if (key === '30d') return 30 * 24 * 60 * 60 * 1000;
  if (key === 'all') return null;
  return 24 * 60 * 60 * 1000;
}

function filterAnalyticsRows(rows, options = {}) {
  const includeInternal = !!options.includeInternal;
  const includeBots = !!options.includeBots;
  const range = String(options.range || 'all');
  const cutoffMs = rangeMs(range);
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const dt = parseTimestamp(row && row.created_at);
    if (!dt) return false;
    if (!includeInternal && row && row.is_internal) return false;
    if (!includeBots && isBotEvent(row)) return false;
    if (cutoffMs != null && (now - dt.getTime()) > cutoffMs) return false;
    return true;
  });
}

async function fetchAnalyticsRows(limit = 5000) {
  const safe = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  const out = await sbFetch(`analytics?select=event,city,created_at,session_id,source,is_internal,path,user_agent,value&order=created_at.desc&limit=${safe}`);
  if (!out.response.ok || !Array.isArray(out.data)) throw new Error('Failed to load analytics rows');
  return out.data;
}

function buildTrafficSummary(rows, options = {}) {
  const allFiltered = filterAnalyticsRows(rows, {
    range: 'all',
    includeInternal: !!options.includeInternal,
    includeBots: !!options.includeBots
  });
  const scoped = filterAnalyticsRows(rows, options);
  const allSessions = new Set(allFiltered.map(normalizeSessionId).filter(Boolean));
  const scopedSessions = new Set(scoped.map(normalizeSessionId).filter(Boolean));
  const allManual = allFiltered.filter((r) => r.event === 'city_search');
  const scopedManual = scoped.filter((r) => r.event === 'city_search');
  const allAuto = allFiltered.filter((r) => r.event === 'city_search_auto');
  const scopedAuto = scoped.filter((r) => r.event === 'city_search_auto');
  const allBots = (Array.isArray(rows) ? rows : []).filter(isBotEvent);
  const scopedBots = filterAnalyticsRows(allBots, {
    range: options.range || '24h',
    includeInternal: true,
    includeBots: true
  });
  const allInternal = (Array.isArray(rows) ? rows : []).filter((r) => r && r.is_internal);
  const scopedInternal = filterAnalyticsRows(allInternal, {
    range: options.range || '24h',
    includeInternal: true,
    includeBots: true
  });
  return {
    range: String(options.range || '24h'),
    sessions: scopedSessions.size,
    manual_searches: scopedManual.length,
    auto_searches: scopedAuto.length,
    search_conversion_pct: scopedSessions.size ? Math.round((scopedManual.length / scopedSessions.size) * 100) : 0,
    all_time_sessions: allSessions.size,
    all_time_manual_searches: allManual.length,
    all_time_auto_searches: allAuto.length,
    excluded_internal_in_range: options.includeInternal ? 0 : scopedInternal.length,
    excluded_bots_in_range: options.includeBots ? 0 : scopedBots.length
  };
}

function buildActivitySummary(rows, options = {}) {
  const scoped = filterAnalyticsRows(rows, Object.assign({ range: '24h' }, options));
  const allFiltered = filterAnalyticsRows(rows, {
    range: 'all',
    includeInternal: !!options.includeInternal,
    includeBots: !!options.includeBots
  });
  const sessionSet = new Set(scoped.map(normalizeSessionId).filter(Boolean));
  const eventCounts = {};
  const cityCounts = {};
  scoped.forEach((row) => {
    const evt = String(row.event || 'unknown');
    const city = String(row.city || '').trim();
    eventCounts[evt] = (eventCounts[evt] || 0) + 1;
    if (city) cityCounts[city] = (cityCounts[city] || 0) + 1;
  });
  const topEvent = Object.entries(eventCounts).sort((a, b) => b[1] - a[1])[0] || ['--', 0];
  const topCity = Object.entries(cityCounts).sort((a, b) => b[1] - a[1])[0] || ['--', 0];
  return {
    range: String(options.range || '24h'),
    events: scoped.length,
    sessions: sessionSet.size,
    top_event: { name: topEvent[0], count: topEvent[1] },
    top_city: { name: topCity[0], count: topCity[1] },
    event_mix: Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
    city_mix: Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
    rows: scoped.slice(0, 100),
    all_time_events: allFiltered.length
  };
}

async function getTrafficSummary(options = {}) {
  const rows = await fetchAnalyticsRows(options.limit || 5000);
  return buildTrafficSummary(rows, options);
}

async function getActivitySummary(options = {}) {
  const rows = await fetchAnalyticsRows(options.limit || 5000);
  return buildActivitySummary(rows, options);
}

module.exports = {
  parseTimestamp,
  isBotEvent,
  filterAnalyticsRows,
  fetchAnalyticsRows,
  buildTrafficSummary,
  buildActivitySummary,
  getTrafficSummary,
  getActivitySummary
};
