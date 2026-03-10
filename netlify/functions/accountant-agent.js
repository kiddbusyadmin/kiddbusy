const { logAgentActivity } = require('./_agent-activity');
const {
  buildFinanceSnapshot,
  upsertFinanceSnapshot,
  addManualEntry,
  getFinanceSettings,
  sbFetch
} = require('./_accounting-core');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

async function listRecentSnapshots(limit = 14) {
  const safe = Math.min(Math.max(Number(limit) || 14, 1), 90);
  const { response, data } = await sbFetch(`finance_snapshots?select=*&order=snapshot_date.desc&limit=${safe}`);
  if (!response.ok) throw new Error('Failed to load finance snapshots');
  return Array.isArray(data) ? data : [];
}

async function listManualEntries(limit = 50) {
  const safe = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const { response, data } = await sbFetch(`finance_manual_entries?select=*&order=entry_date.desc,created_at.desc&limit=${safe}`);
  if (!response.ok) throw new Error('Failed to load manual entries');
  return Array.isArray(data) ? data : [];
}

async function updateSettings(body) {
  const patch = {};
  const fields = ['default_monthly_api_cost', 'default_monthly_subscription_cost', 'churn_rate_monthly', 'growth_rate_monthly'];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = Number(body[f]);
  }
  patch.updated_at = new Date().toISOString();
  const { response, data } = await sbFetch('finance_settings?id=eq.1', {
    method: 'PATCH',
    body: patch,
    prefer: 'return=representation'
  });
  if (!response.ok) throw new Error('Failed to update finance settings');
  return Array.isArray(data) && data.length ? data[0] : patch;
}

exports.handler = async (event) => {
  const source = (event.headers['x-requested-from'] || event.headers['X-Requested-From'] || '').toLowerCase();
  if (!['kiddbusy-hq', 'kiddbusy-agent'].includes(source)) {
    return json(403, { error: 'Forbidden' });
  }

  try {
    if (event.httpMethod === 'GET') {
      const [settings, snapshotPreview, snapshots, entries] = await Promise.all([
        getFinanceSettings(),
        buildFinanceSnapshot(),
        listRecentSnapshots(14),
        listManualEntries(30)
      ]);
      return json(200, {
        success: true,
        settings,
        snapshot_preview: snapshotPreview,
        snapshots,
        manual_entries: entries
      });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }

    const action = String(body.action || 'run_snapshot');
    if (action === 'run_snapshot') {
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      await logAgentActivity({
        agentKey: 'accountant_agent',
        status: 'success',
        summary: `Finance snapshot updated. MRR $${snapshot.mrr_active}, projected 30d net $${snapshot.net_projection_30d}.`,
        details: snapshot
      });
      return json(200, { success: true, snapshot });
    }

    if (action === 'add_manual_entry') {
      const entry = await addManualEntry(body);
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      await logAgentActivity({
        agentKey: 'accountant_agent',
        status: 'info',
        summary: `Manual ${entry.kind} entry added: $${entry.amount} (${entry.category}).`,
        details: { entry, snapshot_date: snapshot.snapshot_date, net_projection_30d: snapshot.net_projection_30d }
      });
      return json(200, { success: true, entry, snapshot });
    }

    if (action === 'update_settings') {
      const settings = await updateSettings(body);
      const snapshot = await upsertFinanceSnapshot(await buildFinanceSnapshot());
      await logAgentActivity({
        agentKey: 'accountant_agent',
        status: 'info',
        summary: 'Finance settings updated.',
        details: { settings, snapshot_date: snapshot.snapshot_date, net_projection_30d: snapshot.net_projection_30d }
      });
      return json(200, { success: true, settings, snapshot });
    }

    return json(400, { error: 'Unsupported action' });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
