const { sendCompliantEmail } = require('./_email-compliance');

const SUPABASE_URL = process.env.KB_DB_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.KB_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUBMISSION_ALERT_EMAIL = process.env.SUBMISSION_ALERT_EMAIL || 'admin@kiddbusy.com';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(payload)
  };
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max || 300);
}

function isValidEmail(value) {
  const v = cleanText(value, 200);
  return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function sbInsertSubmission(row) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(row)
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

function buildAdminAlertHtml(row) {
  const submittedBy = row.submitter_name || row.submitter_email || 'Anonymous';
  return [
    '<div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:8px 0">',
    '<p style="font-size:12px;letter-spacing:.4px;color:#6b7280;text-transform:uppercase;margin:0 0 10px">KiddBusy Submission Alert</p>',
    '<h2 style="font-size:22px;margin:0 0 12px">New organic listing submission</h2>',
    '<p style="margin:0 0 12px">A new public listing submission was received and is waiting in Command Center.</p>',
    '<table style="width:100%;border-collapse:collapse;font-size:14px">',
    `<tr><td style="padding:6px 0;font-weight:700;width:170px">Business</td><td style="padding:6px 0">${row.business_name || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Type</td><td style="padding:6px 0">${row.type || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">City</td><td style="padding:6px 0">${row.city || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Address</td><td style="padding:6px 0">${row.address || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Website</td><td style="padding:6px 0">${row.url || '--'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Submitter</td><td style="padding:6px 0">${submittedBy}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Is owner</td><td style="padding:6px 0">${row.is_owner ? 'yes' : 'no'}</td></tr>`,
    `<tr><td style="padding:6px 0;font-weight:700">Description</td><td style="padding:6px 0">${row.description || '--'}</td></tr>`,
    '</table>',
    '<p style="margin:16px 0 0"><a href="https://kiddbusy.com/admin.html" style="display:inline-block;background:#6c3fc5;color:#fff;text-decoration:none;padding:10px 16px;border-radius:999px;font-weight:700">Open Command Center</a></p>',
    '</div>'
  ].join('');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Supabase service configuration missing' });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const row = {
    business_name: cleanText(body.business_name, 200),
    type: cleanText(body.type, 120),
    city: cleanText(body.city, 120),
    address: cleanText(body.address, 240) || null,
    url: cleanText(body.url, 400) || null,
    description: cleanText(body.description, 2000) || null,
    submitter_name: cleanText(body.submitter_name, 180) || null,
    submitter_email: cleanText(body.submitter_email, 200).toLowerCase() || null,
    age_range: cleanText(body.age_range, 120) || null,
    is_owner: !!body.is_owner,
    wants_sponsorship: !!body.wants_sponsorship,
    status: 'pending'
  };

  if (!row.business_name || !row.type || !row.city) {
    return json(400, { error: 'business_name, type, and city are required' });
  }
  if (!isValidEmail(row.submitter_email)) {
    return json(400, { error: 'Invalid submitter_email' });
  }

  const insert = await sbInsertSubmission(row);
  if (!insert.response.ok) {
    return json(insert.response.status, { error: 'Failed to save submission', details: insert.data });
  }

  const saved = Array.isArray(insert.data) && insert.data.length ? insert.data[0] : row;

  try {
    await sendCompliantEmail({
      to: SUBMISSION_ALERT_EMAIL,
      subject: `New KiddBusy submission: ${row.business_name} (${row.city})`,
      body: buildAdminAlertHtml(row),
      fromName: 'KiddBusy Alerts',
      campaignType: 'submission_alert',
      allowSuppressedBypass: true
    });
  } catch (_) {
    // Keep the public submission flow resilient even if email delivery fails.
  }

  return json(200, { success: true, submission: saved });
};
