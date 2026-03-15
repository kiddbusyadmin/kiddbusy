const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function planAmount(planRaw) {
  const v = String(planRaw || '').toLowerCase();
  if (v.includes('bundle') || v.includes('219')) return 219;
  if (v.includes('banner') || v.includes('199')) return 199;
  return 49;
}

function nowIso() {
  return new Date().toISOString();
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function sbFetch(path, { method = 'GET', body = null, prefer = null } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase service configuration missing');
  }
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

async function getFinanceSettings() {
  const { response, data } = await sbFetch('finance_settings?id=eq.1&select=*');
  if (!response.ok) throw new Error('Failed to load finance settings');
  const row = Array.isArray(data) && data.length ? data[0] : null;
  return row || {
    id: 1,
    default_monthly_api_cost: 0,
    default_monthly_subscription_cost: 0,
    churn_rate_monthly: 0.05,
    growth_rate_monthly: 0.08
  };
}

async function getSponsorshipRows(limit = 5000) {
  const { response, data } = await sbFetch(`sponsorships?select=*&limit=${Math.min(Math.max(Number(limit) || 1000, 1), 5000)}`);
  if (!response.ok) throw new Error('Failed to load sponsorships');
  return Array.isArray(data) ? data : [];
}

async function getManualEntriesLast30() {
  const since = dateDaysAgo(30);
  const { response, data } = await sbFetch(`finance_manual_entries?select=*&entry_date=gte.${encodeURIComponent(since)}&limit=2000`);
  if (!response.ok) {
    // Keep agent resilient if table isn't present yet.
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function sum(values) {
  return values.reduce((acc, n) => acc + (Number(n) || 0), 0);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function buildFinanceSnapshot() {
  const [settings, sponsorships, manualEntries] = await Promise.all([
    getFinanceSettings(),
    getSponsorshipRows(),
    getManualEntriesLast30()
  ]);

  const active = sponsorships.filter((s) => {
    const st = String(s.status || '').toLowerCase();
    return st === 'active' || st === 'cancel_at_period_end';
  });
  const cancelled = sponsorships.filter((s) => String(s.status || '').toLowerCase() === 'cancelled');
  const pending = sponsorships.filter((s) => {
    const st = String(s.status || '').toLowerCase();
    return st === 'pending' || st === 'pending_review' || st === 'approved_awaiting_payment' || st === 'past_due';
  });

  const activeMrr = round2(sum(active.map((s) => planAmount(s.plan))));
  const avgActivePlan = active.length ? round2(activeMrr / active.length) : 0;
  const activeCreated30 = active.filter((s) => {
    const ts = s.created_at ? new Date(s.created_at).getTime() : NaN;
    return Number.isFinite(ts) && (Date.now() - ts) <= 30 * 24 * 60 * 60 * 1000;
  }).length;
  const churnRate = Math.max(0, Number(settings.churn_rate_monthly) || 0);
  const growthRate = Math.max(0, Number(settings.growth_rate_monthly) || 0);

  // Projection model (simple, transparent):
  // 30-day projection = current MRR less churn + growth from recent active pace.
  const churnLoss = activeMrr * churnRate;
  const growthLift = Math.max(activeCreated30 * avgActivePlan, activeMrr * growthRate * 0.5);
  const projectedRevenue30d = round2(Math.max(0, activeMrr - churnLoss + growthLift));

  const apiCost30d = round2(Number(settings.default_monthly_api_cost) || 0);
  const subCost30d = round2(Number(settings.default_monthly_subscription_cost) || 0);

  const manualRevenue30d = round2(sum(manualEntries.filter((e) => String(e.kind || '').toLowerCase() === 'revenue').map((e) => e.amount)));
  const manualExpense30d = round2(sum(manualEntries.filter((e) => String(e.kind || '').toLowerCase() === 'expense').map((e) => e.amount)));

  const netProjection30d = round2(projectedRevenue30d + manualRevenue30d - apiCost30d - subCost30d - manualExpense30d);

  const details = {
    assumptions: {
      churn_rate_monthly: churnRate,
      growth_rate_monthly: growthRate,
      active_created_30d: activeCreated30,
      avg_active_plan_amount: avgActivePlan
    },
    paid_listings: active.slice(0, 200).map((s) => ({
      id: s.id,
      business_name: s.business_name || null,
      plan: s.plan || null,
      email: s.email || null,
      city: s.city || null,
      status: s.status || null
    })),
    no_longer_paid: cancelled.slice(0, 200).map((s) => ({
      id: s.id,
      business_name: s.business_name || null,
      plan: s.plan || null,
      email: s.email || null,
      city: s.city || null,
      status: s.status || null
    }))
  };

  return {
    snapshot_date: new Date().toISOString().slice(0, 10),
    active_sponsors: active.length,
    cancelled_sponsors: cancelled.length,
    pending_sponsors: pending.length,
    mrr_active: activeMrr,
    projected_revenue_30d: projectedRevenue30d,
    api_cost_30d: apiCost30d,
    subscription_cost_30d: subCost30d,
    manual_revenue_30d: manualRevenue30d,
    manual_expense_30d: manualExpense30d,
    net_projection_30d: netProjection30d,
    details,
    updated_at: nowIso()
  };
}

async function upsertFinanceSnapshot(snapshot) {
  const row = snapshot || await buildFinanceSnapshot();
  const { response, data } = await sbFetch('finance_snapshots?on_conflict=snapshot_date', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  if (!response.ok) throw new Error('Failed to upsert finance snapshot');
  return Array.isArray(data) && data.length ? data[0] : row;
}

async function addManualEntry(entry) {
  const body = {
    entry_date: String(entry.entry_date || new Date().toISOString().slice(0, 10)),
    kind: String(entry.kind || '').toLowerCase() === 'revenue' ? 'revenue' : 'expense',
    amount: Number(entry.amount || 0),
    category: String(entry.category || 'general').slice(0, 120),
    vendor: entry.vendor ? String(entry.vendor).slice(0, 180) : null,
    notes: entry.notes ? String(entry.notes).slice(0, 1200) : null,
    source: String(entry.source || 'manual').slice(0, 80)
  };
  if (!(body.amount >= 0)) throw new Error('Amount must be >= 0');
  const { response, data } = await sbFetch('finance_manual_entries', {
    method: 'POST',
    body,
    prefer: 'return=representation'
  });
  if (!response.ok) throw new Error('Failed to save manual entry');
  return Array.isArray(data) && data.length ? data[0] : body;
}

module.exports = {
  buildFinanceSnapshot,
  upsertFinanceSnapshot,
  addManualEntry,
  getFinanceSettings,
  sbFetch
};
