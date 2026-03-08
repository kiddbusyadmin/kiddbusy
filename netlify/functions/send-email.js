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

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'RESEND_API_KEY not configured' }) };
  }

  // Detect if body is HTML or plain text
  const isHtml = emailBody.trim().startsWith('<');

  const payload = {
    from: `${from_name} <admin@kiddbusy.com>`,
    to: [to],
    subject,
    ...(isHtml ? { html: emailBody } : { text: emailBody })
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: result.message || result.name || 'Resend API error', details: result })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, id: result.id })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
