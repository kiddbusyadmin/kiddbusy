const { sendCompliantEmail } = require('./_email-compliance');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const origin = event.headers['x-requested-from'];
  if (origin !== 'kiddbusy-agent') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { to, subject, body: emailBody, from_name = 'KiddBusy' } = body;

  if (!to || !subject || !emailBody) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: to, subject, body' }) };
  }

  try {
    const result = await sendCompliantEmail({
      to,
      subject,
      body: emailBody,
      fromName: from_name || 'KiddBusy',
      campaignType: 'agent_send_email'
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, id: result.id || null, suppressed: !!result.suppressed })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
