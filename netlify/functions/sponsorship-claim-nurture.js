const { json, processClaimNurture } = require('./_sponsorship-claim-nurture');

const RUN_TOKEN = process.env.CMO_RUN_TOKEN || process.env.ADMIN_PASSWORD || '';

exports.handler = async function handler(event) {
  try {
    const ev = event || {};
    const method = String(ev.httpMethod || 'GET').toUpperCase();
    const headers = ev.headers || {};
    let body = {};
    if (method === 'POST') {
      try {
        body = JSON.parse(ev.body || '{}');
      } catch (e) {
        return json(400, { error: 'Invalid JSON body' });
      }
    }

    const isCron = method === 'GET';
    const source = String(headers['x-requested-from'] || headers['X-Requested-From'] || '').toLowerCase();
    const tokenMatch = !!(RUN_TOKEN && String(body.run_token || '') === RUN_TOKEN);
    if (!isCron && source !== 'kiddbusy-hq' && !tokenMatch) {
      return json(403, { error: 'Forbidden' });
    }

    const limit = Number(body.limit || (isCron ? 120 : 200));
    const dryRun = !!body.dry_run;
    const out = await processClaimNurture({ limit: limit, dryRun: dryRun });
    return json(200, out);
  } catch (err) {
    return json(500, { error: String((err && err.message) || err || 'Unexpected error') });
  }
};
